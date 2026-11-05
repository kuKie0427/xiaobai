'use strict';

const { Readable, Transform } = require('node:stream');
const zlib = require('node:zlib');
const {
    NovelV5StreamError,
    readNovelV5FinalImage: parseNovelV5FinalImage,
} = require('./vendor/novel-v5-parser.cjs');

function createDecodedStream(response) {
    const encoding = String(response?.headers?.['content-encoding'] || '').trim().toLowerCase();
    if (!encoding || encoding === 'identity') return response;
    const decoder = encoding === 'gzip' || encoding === 'x-gzip'
        ? zlib.createGunzip()
        : encoding === 'deflate'
            ? zlib.createInflate()
            : encoding === 'br'
                ? zlib.createBrotliDecompress()
                : null;
    if (!decoder) {
        response.destroy();
        throw new NovelV5StreamError(`NovelAI V5 使用了不支持的响应压缩：${encoding}`);
    }
    response.pipe(decoder);
    return decoder;
}

async function readNovelV5FinalImage(response, options = {}) {
    if (!response || typeof response.pipe !== 'function') {
        throw new NovelV5StreamError('NovelAI V5 响应没有可读取的数据流');
    }

    const decodedStream = createDecodedStream(response);
    let streamBytes = 0;
    const counter = new Transform({
        transform(chunk, _encoding, callback) {
            streamBytes += chunk.length;
            callback(null, chunk);
        },
    });
    const forwardDecodedError = error => counter.destroy(error);
    const forwardResponseError = error => decodedStream.destroy(error);
    decodedStream.once('error', forwardDecodedError);
    if (decodedStream !== response) response.once('error', forwardResponseError);
    decodedStream.pipe(counter);

    try {
        const image = await parseNovelV5FinalImage(
            { body: Readable.toWeb(counter) },
            options,
        );
        // 旧版 vendor 返回裸 Uint8Array；当前 vendor 返回 { bytes, mime }（V5 已支持 JPEG/WebP/GIF）。
        const bytes = image?.bytes instanceof Uint8Array ? image.bytes : image;
        const mime = typeof image?.mime === 'string' && image.mime ? image.mime : 'image/png';
        return {
            buffer: Buffer.from(bytes),
            mime,
            streamBytes,
        };
    } finally {
        decodedStream.removeListener('error', forwardDecodedError);
        response.removeListener('error', forwardResponseError);
        decodedStream.unpipe(counter);
        counter.destroy();
        if (decodedStream !== response) decodedStream.destroy();
        if (!response.complete) response.destroy();
    }
}

module.exports = {
    NovelV5StreamError,
    readNovelV5FinalImage,
};
