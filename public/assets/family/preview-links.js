import { installShare } from './share.js?v=release2';
installShare();
document.addEventListener('keydown',event=>{
 if(event.key!=='Escape')return;
 const menu=document.querySelector('.nn-mobile[open]');
 if(menu){menu.open=false;menu.querySelector('summary')?.focus();}
});
document.addEventListener('click',event=>{
 const menu=document.querySelector('.nn-mobile[open]');
 if(menu && (!menu.contains(event.target)||event.target.closest('a')))menu.open=false;
});
// Local review only: production and installed/offline builds keep canonical links.
if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
  const previews = { 'sim.narenana.com': 'http://localhost:8788', 'nanawing2.narenana.com': 'http://localhost:8789', 'www.narenana.com': 'http://localhost:8787' };
  const update = () => document.querySelectorAll('a[href]').forEach(a => {
    const url = new URL(a.href, location.href);
    if ((url.hostname === 'www.narenana.com' || ((url.hostname === 'localhost' || url.hostname === '127.0.0.1') && url.port === '8787')) && url.pathname.startsWith('/log-viewer/')) a.href = 'http://localhost:8790' + url.pathname.slice('/log-viewer'.length) + url.search + url.hash;
    else if (previews[url.hostname]) a.href = previews[url.hostname] + url.pathname + url.search + url.hash;
  });
  update(); new MutationObserver(update).observe(document.body, { childList: true, subtree: true });
}
