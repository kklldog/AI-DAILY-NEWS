export function findPublishedTitle(body, title, prefix = false) {
  const text = body.replace(/\s+/g, ' ');
  const key = title.replace(/\s+/g, ' ').trim();
  if (!key) return -1;
  for (let index = text.indexOf(key); index !== -1; index = text.indexOf(key, index + 1)) {
    const next = text[index + key.length];
    if (!next || /\s/.test(next) || (prefix && /[｜|：:—–]/.test(next))) return index;
  }
  return -1;
}

export function hasStandaloneAdminVerification(root, isVisible) {
  let title = false, instruction = false;
  for (const element of root.querySelectorAll('*')) {
    if (element.closest('.ProseMirror,[contenteditable="true"]') || !isVisible(element)) continue;
    const text = (element.innerText || '').trim();
    if (text === '微信验证') title = true;
    if (text === '扫码后，请联系管理员进行验证') instruction = true;
    if (title && instruction) return true;
  }
  return false;
}
