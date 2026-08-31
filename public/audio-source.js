export function resolveAudioSourcePreference(savedSource, availableDeviceIds = []) {
  if (savedSource === null) return { value: '', remove: false };
  if (!savedSource || savedSource === 'display') return { value: '', remove: true };
  if (availableDeviceIds.includes(savedSource)) return { value: savedSource, remove: false };
  return { value: '', remove: true };
}
