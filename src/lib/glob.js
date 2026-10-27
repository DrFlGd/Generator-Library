// Tiny glob for release asset names: `*` matches anything except `/`, `?` one
// character, everything else literal. Case-insensitive because Windows users name
// assets however the build tool felt like that day.
export function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  return new RegExp(`^${escaped}$`, 'i');
}

export function matchesGlob(name, glob) {
  return globToRegExp(glob).test(name);
}
