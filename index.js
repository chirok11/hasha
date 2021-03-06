'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const isStream = require('is-stream');

const {Worker} = (() => {
	try {
		return require('worker_threads');
	} catch (_) {
		return {};
	}
})();

let worker; // Lazy
let taskIdCounter = 0;
const tasks = new Map();

const recreateWorkerError = sourceError => {
	const error = new Error(sourceError.message);

	for (const [key, value] of Object.entries(sourceError)) {
		if (key !== 'message') {
			error[key] = value;
		}
	}

	return error;
};

const createWorker = () => {
	worker = new Worker(`'use strict';
	const fs = require('fs');
	const crypto = require('crypto');
	const {parentPort} = require('worker_threads');
	
	const handlers = {
		hashFile: (algorithm, filePath) => new Promise((resolve, reject) => {
			const hasher = crypto.createHash(algorithm);
			fs.createReadStream(filePath)
				.on('error', reject)
				.pipe(hasher)
				.on('error', reject)
				.on('finish', () => {
					const {buffer} = new Uint8Array(hasher.read());
					resolve({value: buffer, transferList: [buffer]});
				});
		}),
		hash: async (algorithm, input) => {
			const hasher = crypto.createHash(algorithm);
	
			if (Array.isArray(input)) {
				for (const part of input) {
					hasher.update(part);
				}
			} else {
				hasher.update(input);
			}
	
			const {buffer} = new Uint8Array(hasher.digest());
			return {value: buffer, transferList: [buffer]};
		}
	};
	
	parentPort.on('message', async message => {
		try {
			const {method, args} = message;
			const handler = handlers[method];
	
			if (handler === undefined) {
				throw new Error(\`Unknown method '\${method}'\`);
			}
	
			const {value, transferList} = await handler(...args);
			parentPort.postMessage({id: message.id, value}, transferList);
		} catch (error) {
			const newError = {message: error.message, stack: error.stack};
	
			for (const [key, value] of Object.entries(error)) {
				if (typeof value !== 'object') {
					newError[key] = value;
				}
			}
	
			parentPort.postMessage({id: message.id, error: newError});
		}
	});
	`, {eval: true});

	worker.on('message', message => {
		const task = tasks.get(message.id);
		tasks.delete(message.id);

		if (tasks.size === 0) {
			worker.unref();
		}

		if (message.error === undefined) {
			task.resolve(message.value);
		} else {
			task.reject(recreateWorkerError(message.error));
		}
	});

	worker.on('error', error => {
		// Any error here is effectively an equivalent of segfault, and have no scope, so we just throw it on callback level
		throw error;
	});
};

const taskWorker = (method, args, transferList) => new Promise((resolve, reject) => {
	const id = taskIdCounter++;
	tasks.set(id, {resolve, reject});

	if (worker === undefined) {
		createWorker();
	}

	worker.ref();
	worker.postMessage({id, method, args}, transferList);
});

const hasha = (input, options = {}) => {
	let outputEncoding = options.encoding || 'hex';

	if (outputEncoding === 'buffer') {
		outputEncoding = undefined;
	}

	const hash = crypto.createHash(options.algorithm || 'sha512');

	const update = buffer => {
		const inputEncoding = typeof buffer === 'string' ? 'utf8' : undefined;
		hash.update(buffer, inputEncoding);
	};

	if (Array.isArray(input)) {
		input.forEach(update);
	} else {
		update(input);
	}

	return hash.digest(outputEncoding);
};

hasha.stream = (options = {}) => {
	let outputEncoding = options.encoding || 'hex';

	if (outputEncoding === 'buffer') {
		outputEncoding = undefined;
	}

	const stream = crypto.createHash(options.algorithm || 'sha512');
	stream.setEncoding(outputEncoding);
	return stream;
};

hasha.fromStream = async (stream, options = {}) => {
	if (!isStream(stream)) {
		throw new TypeError('Expected a stream');
	}

	return new Promise((resolve, reject) => {
		// TODO: Use `stream.pipeline` and `stream.finished` when targeting Node.js 10
		stream
			.on('error', reject)
			.pipe(hasha.stream(options))
			.on('error', reject)
			.on('finish', function () {
				resolve(this.read());
			});
	});
};

if (Worker === undefined) {
	hasha.fromFile = async (filePath, options) => hasha.fromStream(fs.createReadStream(filePath), options);
	hasha.async = async (input, options) => hasha(input, options);
} else {
	hasha.fromFile = async (filePath, {algorithm = 'sha512', encoding = 'hex'} = {}) => {
		const hash = await taskWorker('hashFile', [algorithm, filePath]);

		if (encoding === 'buffer') {
			return Buffer.from(hash);
		}

		return Buffer.from(hash).toString(encoding);
	};

	hasha.async = async (input, {algorithm = 'sha512', encoding = 'hex'} = {}) => {
		if (encoding === 'buffer') {
			encoding = undefined;
		}

		const hash = await taskWorker('hash', [algorithm, input]);

		if (encoding === undefined) {
			return Buffer.from(hash);
		}

		return Buffer.from(hash).toString(encoding);
	};
}

hasha.fromFileSync = (filePath, options) => hasha(fs.readFileSync(filePath), options);

module.exports = hasha;
