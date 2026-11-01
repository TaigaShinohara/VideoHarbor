let sequence = 0;

// Source URLs and page titles must never become default output names. Chrome
// handles collisions between extension contexts with conflictAction: 'uniquify'.
export function outputName(extension, { recording = false, directory = true, now = new Date() } = {}) {
  if (!/^[a-z0-9]{2,5}$/.test(extension)) throw new TypeError('Invalid output extension');
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${pad(now.getMilliseconds(), 3)}`;
  const basename = `${recording ? 'recording' : 'video'}-${time}-${pad(++sequence, 3)}.${extension}`;
  return directory ? `VideoHarbor/${date}/${basename}` : basename;
}
