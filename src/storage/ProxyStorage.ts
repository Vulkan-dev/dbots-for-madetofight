// ProxyStorage stub — no proxy support on Railway (direct connection only)
export class ProxyStorage {
  static getProxyForAccount(_accountId: string): null {
    return null;
  }
}
