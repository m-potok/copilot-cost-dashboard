class SessionSource {
  constructor(kind, read, fingerprint) {
    this.kind = kind;
    this.read = read;
    this.fingerprint = fingerprint;
  }
}

module.exports = { SessionSource };
