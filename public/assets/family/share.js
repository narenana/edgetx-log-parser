// No SDKs, tracking requests or uploads. Only public canonical URLs are shared.
export function shareData(doc = document) {
  const meta = key => doc.querySelector(`meta[property="${key}"],meta[name="${key}"]`)?.content;
  const canonical = doc.querySelector('link[rel="canonical"]')?.href;
  if (!canonical || !/^https:\/\//.test(canonical)) return null;
  return { title: meta('og:title') || doc.title, text: meta('og:description') || meta('description') || '', url: canonical };
}

export function installShare() {
  if (!shareData() || document.getElementById('nn-share-launcher')) return;
  const css = document.createElement('link');
  css.rel = 'stylesheet'; css.href = new URL('./share.css?v=release2', import.meta.url).href;
  document.head.append(css);
  const button = document.createElement('button');
  button.id = 'nn-share-launcher'; button.type = 'button';
  button.innerHTML = '<svg aria-hidden="true" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 16V3m-5 5 5-5 5 5M5 13v7h14v-7"/></svg> Share';
  button.setAttribute('aria-haspopup', 'dialog');
  const dialog = document.createElement('dialog'); dialog.id = 'nn-share-dialog';
  dialog.setAttribute('aria-labelledby', 'nn-share-heading');
  dialog.innerHTML = `<div class="nn-share-top"><h2 id="nn-share-heading">Share with a flying friend</h2><button type="button" data-close aria-label="Close share dialog">×</button></div><p class="nn-share-title"></p><div class="nn-share-options"><button type="button" data-copy>Copy link</button><button type="button" data-native>More apps…</button><a data-service="whatsapp" target="_blank" rel="noopener noreferrer">WhatsApp ↗</a><a data-service="facebook" target="_blank" rel="noopener noreferrer">Facebook ↗</a><a data-service="linkedin" target="_blank" rel="noopener noreferrer">LinkedIn ↗</a><a data-service="x" target="_blank" rel="noopener noreferrer">X ↗</a><a data-service="email">Email</a></div><label class="nn-share-label" for="nn-share-url">Page link</label><input id="nn-share-url" readonly><p class="nn-share-status" role="status" aria-live="polite"></p>`;
  // Populate links before inserting the dialog: crawlers and assistive tools
  // must see usable destinations even before the first click.
  const populate = () => {
    const data = shareData(); if (!data) return;
    const u = encodeURIComponent(data.url), t = encodeURIComponent(data.title);
    const urls = {whatsapp:`https://wa.me/?text=${encodeURIComponent(data.title+' '+data.url)}`,facebook:`https://www.facebook.com/sharer/sharer.php?u=${u}`,linkedin:`https://www.linkedin.com/sharing/share-offsite/?url=${u}`,x:`https://twitter.com/intent/tweet?text=${t}&url=${u}`,email:`mailto:?subject=${t}&body=${encodeURIComponent(data.text+'\n\n'+data.url)}`};
    dialog.querySelectorAll('[data-service]').forEach(a => a.href = urls[a.dataset.service]);
  };
  populate();
  document.body.append(button, dialog);
  const status = dialog.querySelector('.nn-share-status');
  const input = dialog.querySelector('input');
  let trigger = button;
  const close = () => { dialog.close(); trigger.focus(); };
  const open = event => {
    const data = shareData(); if (!data) return;
    trigger = event?.currentTarget || button;
    const u = encodeURIComponent(data.url), t = encodeURIComponent(data.title);
    const urls = {whatsapp:`https://wa.me/?text=${encodeURIComponent(data.title+' '+data.url)}`,facebook:`https://www.facebook.com/sharer/sharer.php?u=${u}`,linkedin:`https://www.linkedin.com/sharing/share-offsite/?url=${u}`,x:`https://twitter.com/intent/tweet?text=${t}&url=${u}`,email:`mailto:?subject=${t}&body=${encodeURIComponent(data.text+'\n\n'+data.url)}`};
    dialog.querySelectorAll('[data-service]').forEach(a => a.href = urls[a.dataset.service]);
    dialog.querySelector('.nn-share-title').textContent = data.title;
    input.value = data.url; status.textContent = '';
    dialog.querySelector('[data-native]').hidden = !navigator.share;
    if (!dialog.open) dialog.showModal();
  };
  button.addEventListener('click', open);
  document.addEventListener('click', event => { const el=event.target.closest('[data-share-page]'); if(el) open({currentTarget:el}); });
  dialog.querySelector('[data-close]').addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('click', event => { if (event.target === dialog) { const r=dialog.getBoundingClientRect(); if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom) close(); } });
  dialog.querySelector('[data-copy]').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(input.value); status.textContent = 'Link copied. Ready to share!'; }
    catch { input.focus(); input.select(); status.textContent = 'Select and copy the link above.'; }
  });
  dialog.querySelector('[data-native]').addEventListener('click', async () => {
    try { await navigator.share(shareData()); }
    catch (error) { if (error.name !== 'AbortError') status.textContent = 'Sharing is unavailable here. Copy the link or choose an app above.'; }
  });
}
