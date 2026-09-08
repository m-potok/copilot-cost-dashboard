class SessionCatalog {
  constructor(refresh, maxRoots = 8) {
    this.refresh = refresh;
    this.maxRoots = maxRoots;
    this.caches = new Map();
  }

  async read(rootPath) {
    const result = await this.refresh(rootPath, this.caches);
    this.trim();
    return result;
  }

  clear(rootPath = null) {
    if (rootPath === null) {
      this.caches.clear();
      return;
    }
    this.caches.delete(rootPath);
  }

  trim() {
    while (this.caches.size > this.maxRoots) {
      const oldestRoot = this.caches.keys().next().value;
      this.caches.delete(oldestRoot);
    }
  }
}

module.exports = { SessionCatalog };
