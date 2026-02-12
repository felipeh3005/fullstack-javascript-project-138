export class PageLoaderError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = this.constructor.name;
    this.cause = options.cause;
    this.resourceUrl = options.resourceUrl;
    this.filepath = options.filepath;
    this.status = options.status;
  }
}

export class HttpError extends PageLoaderError {}
export class NetworkError extends PageLoaderError {}
export class FileSystemError extends PageLoaderError {}
