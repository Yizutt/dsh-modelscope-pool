// 网页版 / 桌面版 DSH 的管理页面。
// dsh-go 手机端用原生面板，Harness Web（含桌面端内嵌的同一套界面）没有面板，
// 所以在宿主自带的 webServer 上开一个同源页面：http://127.0.0.1:<web 端口>/modelscope-pool
// 页面只读同源 JSON，不跨域；只接受本机回环地址，避免局域网里被人看到令牌。

const PAGE_PATH = '/modelscope-pool'

const HTML = [
  '<!doctype html>',
  '<html lang="zh-CN"><head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  '<title>ModelScope key pool</title>',
  '<style>',
  ':root{color-scheme:light dark;--bg:#fff;--fg:#16181d;--muted:#6b7078;--line:#e3e6ea;--card:#f7f8fa;--good:#1f7a4d;--warn:#8a6100;--bad:#b3261e;--btn:#eceff3}',
  '@media (prefers-color-scheme:dark){:root{--bg:#16181d;--fg:#e8eaee;--muted:#9aa0aa;--line:#2b2f36;--card:#1d2026;--good:#5fd39b;--warn:#e0b355;--bad:#ff8a80;--btn:#262b33}}',
  '*{box-sizing:border-box}',
  'body{margin:0;padding:16px 14px 40px;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,system-ui,"Segoe UI",Roboto,"Noto Sans SC",sans-serif}',
  'h1{margin:0 0 2px;font-size:18px}',
  '.sub{color:var(--muted);font-size:12px;margin-bottom:14px}',
  '.stats{display:flex;gap:10px;margin-bottom:12px}',
  '.stat{flex:1;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px}',
  '.stat b{display:block;font-size:20px;line-height:1.2}',
  '.stat span{color:var(--muted);font-size:12px}',
  '.bar{height:8px;border-radius:6px;background:var(--line);overflow:hidden;margin:6px 0 4px}',
  '.bar i{display:block;height:100%;background:var(--good)}',
  '.row{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}',
  'button{background:var(--btn);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:7px 12px;font:inherit;cursor:pointer}',
  'button:active{opacity:.7}',
  'button.pri{background:var(--fg);color:var(--bg);border-color:var(--fg)}',
  'table{width:100%;border-collapse:collapse;font-size:13px}',
  'th,td{text-align:left;padding:7px 6px;border-bottom:1px solid var(--line);vertical-align:middle}',
  'th{color:var(--muted);font-weight:500;font-size:12px}',
  '.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}',
  '.ok{color:var(--good)}.warn{color:var(--warn)}.bad{color:var(--bad)}',
  '.muted{color:var(--muted)}',
  'td.ops{white-space:nowrap;text-align:right}',
  'td.ops button{padding:4px 8px;font-size:12px;margin-left:4px}',
  'textarea,select{width:100%;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:8px;font:inherit}',
  'textarea{min-height:64px;resize:vertical}',
  '.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--fg);color:var(--bg);padding:9px 16px;border-radius:20px;font-size:13px;opacity:0;transition:opacity .2s;pointer-events:none;max-width:88vw}',
  '.toast.on{opacity:.95}',
  'details{margin-top:18px}summary{cursor:pointer;color:var(--muted);font-size:13px}',
  '</style></head><body>',
  '<h1 id="title">魔搭 Key 池</h1>',
  '<div class="sub" id="sub"></div>',
  '<div class="stats">',
  '<div class="stat"><b id="s-ok">–</b><span id="l-ok"></span></div>',
  '<div class="stat"><b id="s-cool">–</b><span id="l-cool"></span></div>',
  '<div class="stat"><b id="s-magic">–</b><span id="l-magic"></span></div>',
  '</div>',
  '<div class="bar"><i id="bar" style="width:0"></i></div>',
  '<div class="sub" id="magic-cap"></div>',
  '<div class="row">',
  '<button class="pri" data-act="refresh" id="b-refresh"></button>',
  '<button data-act="test" id="b-test"></button>',
  '<button data-act="restoreAll" id="b-restore"></button>',
  '<button id="b-lang"></button>',
  '</div>',
  '<table><thead><tr id="head"></tr></thead><tbody id="rows"></tbody></table>',
  '<div class="row"><button id="b-prev"></button><button id="b-next"></button></div>',
  '<details><summary id="add-sum"></summary>',
  '<div class="row"><textarea id="add-text" placeholder="ms-..."></textarea></div>',
  '<div class="row"><button class="pri" id="b-add"></button></div>',
  '</details>',
  '<details><summary id="model-sum"></summary>',
  '<div class="row"><select id="model-sel"></select></div>',
  '</details>',
  '<div class="toast" id="toast"></div>',
  '<script>',
  'var L=null,S=null,PAGE=0,PER=20,ARM="";',
  'var DICT={',
  ' zh:{title:"魔搭 Key 池",sub:"本页只在 127.0.0.1 上可用；Key 不会离开这台设备。",',
  ' ok:"可用",cool:"冷却",magic:"魔粒",left:"剩余",total:"共",refresh:"刷新额度",test:"测试全部",restoreAll:"全部恢复",',
  ' prev:"上一页",next:"下一页",add:"添加",addSum:"添加 Key（一行一个）",modelSum:"默认模型",',
  ' id:"Key",site:"站点",state:"状态",quota:"额度",ops:"操作",',
  ' disable:"禁用",stop:"停用",restore:"恢复",del:"删除",delAgain:"再点一次",',
  ' ai:"国际版",cn:"国内版",none:"—",empty:"还没有 Key",',
  ' copied:"已刷新",added:"已添加",saved:"已保存",failed:"操作失败",lang:"English"},',
  ' en:{title:"ModelScope keys",sub:"This page only answers on 127.0.0.1; keys never leave this device.",',
  ' ok:"Ready",cool:"Cooling",magic:"Magicubes",left:"left",total:"of",refresh:"Refresh quota",test:"Test all",restoreAll:"Restore all",',
  ' prev:"Prev",next:"Next",add:"Add",addSum:"Add keys (one per line)",modelSum:"Default model",',
  ' id:"Key",site:"Site",state:"State",quota:"Quota",ops:"Actions",',
  ' disable:"Disable",stop:"Pause",restore:"Restore",del:"Delete",delAgain:"Tap again",',
  ' ai:"International",cn:"China",none:"—",empty:"No keys yet",',
  ' copied:"Refreshed",added:"Added",saved:"Saved",failed:"Action failed",lang:"中文"}};',
  'var RSN={"额度不足":["额度不足","Out of quota"],"额度用尽":["额度用尽","Quota exhausted"],"令牌无效":["令牌无效","Invalid token"],"被限流":["被限流","Rate limited"],"模型名不可用":["模型名不可用","Model unavailable"],"上游超时":["上游超时","Upstream timeout"],"读取请求失败":["读取请求失败","Request failed"],"冷却中":["冷却中","Cooling down"],"手动禁用":["手动禁用","Disabled"],"手动停用":["手动停用","Paused"]};',
  'function rsn(r){if(!r)return "";var x=RSN[r];return x?(L===DICT.en?x[1]:x[0]):r}',
  'function t(k){return (L&&L[k])||k}',
  'function pickLang(){try{var s=localStorage.getItem("ms-lang");if(s==="zh"||s==="en")return s}catch(e){}',
  ' var n=(navigator.language||"zh").toLowerCase();return n.indexOf("zh")===0?"zh":"en"}',
  'function setLang(x){L=DICT[x];try{localStorage.setItem("ms-lang",x)}catch(e){}',
  ' document.documentElement.lang=x==="zh"?"zh-CN":"en";',
  ' document.querySelectorAll("[id^=b-lang]").forEach(function(b){b.textContent=L.lang});render()}',
  'function toast(m){var el=document.getElementById("toast");el.textContent=m;el.classList.add("on");',
  ' clearTimeout(window.__t);window.__t=setTimeout(function(){el.classList.remove("on")},2200)}',
  'function fmt(ms){if(!ms)return "";var d=new Date(ms);function p(n){return n<10?"0"+n:""+n}',
  ' return p(d.getMonth()+1)+"-"+p(d.getDate())+" "+p(d.getHours())+":"+p(d.getMinutes())}',
  'function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e}',
  'function render(){',
  ' if(!S||!L)return;',
  ' document.getElementById("title").textContent=L.title;',
  ' document.getElementById("sub").textContent=L.sub;',
  ' document.getElementById("s-ok").textContent=S.available;',
  ' document.getElementById("s-cool").textContent=S.cooling;',
  ' document.getElementById("s-magic").textContent=S.magic.left;',
  ' document.getElementById("l-ok").textContent=L.ok;',
  ' document.getElementById("l-cool").textContent=L.cool;',
  ' document.getElementById("l-magic").textContent=L.magic;',
  ' var pct=S.magic.total>0?Math.max(0,Math.min(100,S.magic.left/S.magic.total*100)):0;',
  ' document.getElementById("bar").style.width=pct.toFixed(1)+"%";',
  ' document.getElementById("magic-cap").textContent=" "+L.left+" "+S.magic.left+" / "+L.total+" "+S.magic.total;',
  ' document.getElementById("b-refresh").textContent=L.refresh;',
  ' document.getElementById("b-test").textContent=L.test;',
  ' document.getElementById("b-restore").textContent=L.restoreAll;',
  ' document.getElementById("b-prev").textContent=L.prev;',
  ' document.getElementById("b-next").textContent=L.next;',
  ' document.getElementById("b-add").textContent=L.add;',
  ' document.getElementById("add-sum").textContent=L.addSum;',
  ' document.getElementById("model-sum").textContent=L.modelSum;',
  ' var head=document.getElementById("head");head.innerHTML="";',
  ' [L.id,L.site,L.state,L.quota,L.ops].forEach(function(h){head.appendChild(el("th",null,h))});',
  ' var body=document.getElementById("rows");body.innerHTML="";',
  ' var maxPage=Math.max(0,Math.ceil(S.keys.length/PER)-1);PAGE=Math.min(PAGE,maxPage);',
  ' var slice=S.keys.slice(PAGE*PER,PAGE*PER+PER);',
  ' if(!slice.length){var tr=el("tr");var td=el("td","muted",L.empty);td.colSpan=5;tr.appendChild(td);body.appendChild(tr)}',
  ' slice.forEach(function(k){',
  '  var tr=el("tr");',
  '  tr.appendChild(el("td","mono",k.id+" "+k.masked));',
  '  tr.appendChild(el("td",null,k.region==="ai"?L.ai:k.region==="cn"?L.cn:L.none));',
  '  var st=el("td",k.state==="ok"?"ok":k.manual?"bad":"warn");',
  '  st.textContent=k.state==="ok"?L.ok:(k.manual?L.disable:rsn(k.reason)||L.cool)+(k.untilAt?" "+fmt(k.untilAt):"");',
  '  tr.appendChild(st);',
  '  var q=el("td",null,k.quota&&k.quota.ok?(k.quota.available+" / "+k.quota.total):L.none);',
  '  tr.appendChild(q);',
  '  var ops=el("td","ops");',
  '  function mk(act,label,cls){var b=el("button",cls,label);b.onclick=function(){act(k.id,label)};ops.appendChild(b);return b}',
  '  if(k.state==="ok"||k.manual){mk(actDisable,L.disable)} else {mk(actRestore,L.restore)}',
  '  mk(actStop,L.stop);',
  '  var delBtn=mk(actDelete,ARM===k.id?L.delAgain:L.del);',
  '  tr.appendChild(ops);',
  '  body.appendChild(tr);',
  ' });',
  ' var sel=document.getElementById("model-sel");sel.innerHTML="";',
  ' S.models.slice(0,400).forEach(function(m){var o=el("option",null,m.name);o.value=m.id;if(m.id===S.model)o.selected=true;sel.appendChild(o)});',
  '}',
  'function post(action,payload){',
  ' var body=Object.assign({action:action},payload||{});',
  ' return fetch("' + PAGE_PATH + '/api/action",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)})',
  '  .then(function(r){return r.json()}).then(function(j){if(j.message)toast(j.message);return load()})',
  '  .catch(function(){toast(L.failed)})',
  '}',
  'function actDisable(id){post("disable",{id:id})}',
  'function actStop(id){post("stop",{id:id})}',
  'function actRestore(id){post("restore",{id:id})}',
  'function actDelete(id){if(ARM!==id){ARM=id;render();return}ARM="";post("remove",{id:id})}',
  'function load(){',
  ' return fetch("' + PAGE_PATH + '/api/state").then(function(r){if(!r.ok)throw 0;return r.json()})',
  '  .then(function(j){S=j;render()}).catch(function(){})',
  '}',
  'document.addEventListener("click",function(e){',
  ' var a=e.target&&e.target.getAttribute&&e.target.getAttribute("data-act");',
  ' if(a){post(a);return}',
  ' if(e.target.id==="b-prev"){if(PAGE>0){PAGE--;render()}return}',
  ' if(e.target.id==="b-next"){if((PAGE+1)*PER<S.keys.length){PAGE++;render()}return}',
  ' if(e.target.id==="b-add"){var v=document.getElementById("add-text").value;',
  '  if(!v.trim())return;post("add",{value:v}).then(function(){document.getElementById("add-text").value=""});return}',
  ' if(e.target.id==="b-lang"){setLang(L===DICT.zh?"en":"zh");return}',
  '});',
  'document.addEventListener("change",function(e){',
  ' if(e.target.id==="model-sel")post("setModel",{value:e.target.value});',
  '});',
  'setLang(pickLang());load();setInterval(load,4000);',
  '</script></body></html>',
].join('\n')

const isLoopback = (req) => {
  const ip = String(req.socket?.remoteAddress ?? '')
  return ip === '::1' || ip.startsWith('127.') || ip.startsWith('::ffff:127.')
}

const send = (res, status, type, body, extra) => {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extra,
  })
  res.end(body)
}

const sendJson = (res, status, value) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(value))

const readBody = (req) =>
  new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 256 * 1024) {
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      let value = null
      try {
        value = text ? JSON.parse(text) : null
      } catch {}
      resolve(value)
    })
    req.on('error', () => resolve(null))
  })

/**
 * 在宿主的 webServer 上挂一个同源管理页。
 * @param webServer 宿主注入的 webServer 服务
 * @param options.getState () => 状态对象
 * @param options.doAction (action, payload) => Promise<string> 返回一行提示
 */
export function registerWebAdmin(webServer, { getState, doAction, logger }) {
  const route = {
    kind: 'prefix',
    path: PAGE_PATH,
    handler: async (req, res) => {
      if (!isLoopback(req)) {
        sendJson(res, 403, { error: 'loopback only' })
        return
      }
      const url = new URL(String(req.url ?? '/'), 'http://127.0.0.1')
      const rest = url.pathname.slice(PAGE_PATH.length).replace(/\/+$/, '')

      if (rest === '' || rest === '/') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        send(res, 200, 'text/html; charset=utf-8', req.method === 'HEAD' ? '' : HTML, {
          'x-frame-options': 'SAMEORIGIN',
          'referrer-policy': 'no-referrer',
        })
        return
      }

      if (rest === '/api/state') {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        try {
          sendJson(res, 200, getState())
        } catch (error) {
          logger?.warn?.(`modelscope-pool: 网页状态读取失败 ${String(error?.message ?? error)}`)
          sendJson(res, 500, { error: 'state failed' })
        }
        return
      }

      if (rest === '/api/action') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        const body = await readBody(req)
        if (!body || typeof body.action !== 'string') {
          sendJson(res, 400, { error: 'bad request' })
          return
        }
        try {
          const message = await doAction(body.action, body)
          sendJson(res, 200, { ok: true, message: message ?? '' })
        } catch (error) {
          logger?.warn?.(`modelscope-pool: 网页操作失败 ${String(error?.message ?? error)}`)
          sendJson(res, 200, { ok: false, message: String(error?.message ?? error) })
        }
        return
      }

      sendJson(res, 404, { error: 'not found' })
    },
  }
  return webServer.register(route)
}

export const WEB_ADMIN_PATH = PAGE_PATH