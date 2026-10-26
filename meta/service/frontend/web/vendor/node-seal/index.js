import MainModuleFactory from './seal_throws.js';
export async function initialize(options = {}) {
    return await MainModuleFactory({
        locateFile: (path) => new URL(path, import.meta.url).href,
        ...options
    });
}
export default initialize;
