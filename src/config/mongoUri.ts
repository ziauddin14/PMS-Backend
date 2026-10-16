const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Returns the host names (without ports) listed in a MongoDB connection string. */
export function extractMongoHosts(uri: string): string[] {
  const match = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)/.exec(uri);
  if (!match?.[1]) return [];
  return match[1]
    .split(',')
    .map((hostPort) => {
      const trimmed = hostPort.trim();
      if (trimmed.startsWith('[')) return trimmed.slice(0, trimmed.indexOf(']') + 1);
      return trimmed.split(':')[0] ?? '';
    })
    .filter((host) => host.length > 0)
    .map((host) => host.toLowerCase());
}

export function isLocalMongoUri(uri: string): boolean {
  if (uri.startsWith('mongodb+srv://')) return false;
  const hosts = extractMongoHosts(uri);
  return hosts.length > 0 && hosts.every((host) => LOCAL_HOSTS.has(host));
}

/** Replaces any credentials in a MongoDB connection string, for safe display. */
export function redactMongoUri(uri: string): string {
  return uri.replace(/^(mongodb(?:\+srv)?:\/\/)[^@/]*@/, '$1***@');
}
