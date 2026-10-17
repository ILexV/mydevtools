import{a as e,f as t,i as n,l as r,r as i}from"./tool-ui.bHiPSqdl.js";import{t as a}from"./automatic-use.D-cLgnOk.js";var o=new Set(`a.abbr.b.blockquote.br.caption.cite.code.col.colgroup.dd.del.details.dfn.div.dl.dt.em.figcaption.figure.h1.h2.h3.h4.h5.h6.hr.i.img.input.ins.kbd.li.mark.ol.p.pre.q.rp.rt.ruby.s.samp.small.span.strong.sub.summary.sup.table.tbody.td.tfoot.th.thead.time.tr.u.ul.var.wbr`.split(`.`)),s=new Set(`script.style.iframe.frame.frameset.object.embed.applet.template.noscript.noembed.noframes.xmp.plaintext.svg.math.form.textarea.select.option.button.link.meta.base.title.head.audio.video.source.track.canvas.portal.dialog`.split(`.`)),c=new Set([`title`,`lang`,`dir`]),l={a:new Set([`href`]),img:new Set([`src`,`alt`,`width`,`height`]),td:new Set([`align`,`colspan`,`rowspan`]),th:new Set([`align`,`colspan`,`rowspan`,`scope`]),col:new Set([`span`]),colgroup:new Set([`span`]),ol:new Set([`start`,`reversed`]),li:new Set([`value`]),details:new Set([`open`]),input:new Set([`type`,`checked`,`disabled`]),time:new Set([`datetime`]),q:new Set([`cite`]),blockquote:new Set([`cite`])},u=new Set([`http`,`https`,`mailto`,`tel`]),d=/^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,[a-z0-9+/=\s]*$/i;function f(e,t){let n=e.replace(/[\u0000- \u007f-\u009f]/g,``),r=/^([a-z][a-z0-9+.-]*):/i.exec(n)?.[1]?.toLowerCase();return r===void 0?!0:t===`src`?r===`http`||r===`https`||r===`data`&&d.test(n):u.has(r)}function p(e,t,n){return t.startsWith(`on`)?!1:t===`class`?e===`code`&&/^language-[\w+#.-]+$/.test(n.trim()):t===`href`||t===`cite`?(l[e]?.has(t)??!1)&&f(n,`href`):t===`src`?e===`img`&&f(n,`src`):e===`input`&&t===`type`?n.toLowerCase()===`checkbox`:c.has(t)||(l[e]?.has(t)??!1)}function m(e){return s.has(e)?`drop`:o.has(e)?`keep`:`unwrap`}function h(e){let t=e.localName;for(let n of Array.from(e.attributes))p(t,n.name.toLowerCase(),n.value)||e.removeAttribute(n.name);if(t===`input`){if(e.getAttribute(`type`)?.toLowerCase()!==`checkbox`){e.remove();return}e.setAttribute(`disabled`,``)}t===`a`&&e.hasAttribute(`href`)&&(e.setAttribute(`target`,`_blank`),e.setAttribute(`rel`,`noopener noreferrer nofollow`))}function g(e){for(let t of Array.from(e.childNodes)){if(t.nodeType===8){t.remove();continue}if(t.nodeType!==1)continue;let e=t;if(e.namespaceURI!==`http://www.w3.org/1999/xhtml`){e.remove();continue}let n=m(e.localName);if(n===`drop`){e.remove();continue}if(g(e),n===`unwrap`){e.replaceWith(...Array.from(e.childNodes));continue}h(e)}}function _(e,t=document){let n=t.createElement(`template`);return n.innerHTML=e,g(n.content),n.content}function v(e){return Math.min(Math.max(e,1),6)+1}function y(e,t=document){for(let n of Array.from(e.querySelectorAll(`h1, h2, h3, h4, h5, h6`))){let e=Number(n.tagName.charAt(1)),r=v(e),i=r<=6?t.createElement(`h${r}`):t.createElement(`div`);r>6&&(i.setAttribute(`role`,`heading`),i.setAttribute(`aria-level`,String(r))),i.className=`md-h${e}`,i.append(...Array.from(n.childNodes)),n.replaceWith(i)}}var b={breaks:!0,gfm:!0,headerIds:!0,mangle:!1},x=`/`.replace(/\/$/,``),S=null;function C(){return window.marked?Promise.resolve():(S||=new Promise((e,t)=>{let n=`${x}/lib/marked.min.js`,r=document.querySelector(`script[src="${n}"]`);if(r){if(r.dataset.loaded===`true`){e();return}r.addEventListener(`load`,()=>e(),{once:!0}),r.addEventListener(`error`,()=>t(Error(`Failed to load ${n}`)),{once:!0});return}let i=document.createElement(`script`);i.src=n,i.async=!1,i.addEventListener(`load`,()=>{i.dataset.loaded=`true`,e()},{once:!0}),i.addEventListener(`error`,()=>{i.remove(),t(Error(`Failed to load ${n}`))},{once:!0}),document.body.appendChild(i)}).catch(e=>{throw S=null,e}),S)}function w(){let e=document.querySelector(`[data-md-strings]`);if(!e)return null;try{return JSON.parse(e.textContent||`{}`)}catch{return null}}function T(){let o=document.querySelector(`[data-md-tool]`);if(!o)return;let s=w();if(!s)return;let c=s,l=o.querySelector(`[data-md-input]`),u=o.querySelector(`[data-md-output]`),d=o.querySelector(`[data-md-error]`);if(!l||!u||!d)return;let f=l,p=u,m=d,h=o.querySelector(`[data-md-sync-scroll]`),g=o.querySelector(`[data-md-input-host]`),v=o.querySelector(`[data-md-output-panel]`),x=o.querySelector(`[data-md-example]`),S=g?i(g,f):()=>{},T=o.querySelector(`[data-md-copy-html]`),E=o.querySelector(`[data-md-copy-md]`),D=o.querySelector(`[data-md-download]`);function O(){let e=f.value.trim()===``;for(let t of[T,E,D])t&&(t.disabled=e)}let k=``,A=a(`markdown-preview`);function j(e=!1){S(),v&&t(v,f.value===``),O();let n=e&&f.value.trim()?A.start():null;try{if(window.marked){let e=_(window.marked.parse(f.value,b)),t=document.createElement(`div`);t.append(e.cloneNode(!0)),k=t.innerHTML,y(e),p.replaceChildren(e)}else{k=``,p.textContent=``;let e=document.createElement(`p`);e.className=`md-lib-error`,e.textContent=c.markedLoadFailed,p.appendChild(e)}m.hidden=!0,window.marked?n?.complete():n?.fail(`processing_error`)}catch(e){let t=e instanceof Error?e.message:String(e);m.textContent=c.renderError.replace(`{message}`,t),m.hidden=!1,n?.fail(`invalid_input`)}}function M(e,t=``){let n=f.selectionStart,r=f.selectionEnd,i=f.value.substring(n,r),a=e+i+t;f.value=f.value.substring(0,n)+a+f.value.substring(r);let o=n+e.length+i.length;f.setSelectionRange(o,o),f.focus(),A.changed(),j(!0)}function N(e){let t=f.selectionStart,n=f.value.split(`
`),r=0,i=0;for(let e=0;e<n.length;e++){let a=n[e]??``;if(r+a.length>=t){i=e;break}r+=a.length+1}n[i]=e+(n[i]??``),f.value=n.join(`
`);let a=t+e.length;f.setSelectionRange(a,a),f.focus(),A.changed(),j(!0)}async function P(t,n){await e(n,t,c.copied)||(m.textContent=c.copyFailed,m.hidden=!1)}function F(){let e=`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Markdown Preview</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            line-height: 1.6;
            max-width: 800px;
            margin: 2rem auto;
            padding: 0 1rem;
            color: #333;
        }
        code {
            background: #f4f4f4;
            padding: 0.2em 0.4em;
            border-radius: 3px;
            font-family: "Courier New", monospace;
        }
        pre {
            background: #f4f4f4;
            padding: 1rem;
            border-radius: 5px;
            overflow-x: auto;
        }
        pre code {
            background: none;
            padding: 0;
        }
        table {
            border-collapse: collapse;
            width: 100%;
            margin: 1rem 0;
        }
        th, td {
            border: 1px solid #ddd;
            padding: 0.5rem;
            text-align: left;
        }
        th {
            background: #f4f4f4;
        }
        blockquote {
            border-left: 4px solid #ddd;
            padding-left: 1rem;
            margin-left: 0;
            color: #666;
        }
        img {
            max-width: 100%;
        }
    </style>
</head>
<body>
`+k+`
</body>
</html>`,t=new Blob([e],{type:`text/html`}),n=URL.createObjectURL(t),r=document.createElement(`a`);r.href=n,r.download=`markdown-preview.html`,r.click(),URL.revokeObjectURL(n)}f.addEventListener(`input`,e=>{if(!e.isTrusted){j();return}A.changed(),window.marked?j(!0):C().catch(()=>void 0).finally(()=>j(!0))});let I={bold:()=>M(`**`,`**`),italic:()=>M(`*`,`*`),heading:()=>N(`## `),link:()=>M(`[`,`](url)`),image:()=>M(`![alt text](`,`)`),code:()=>M("`","`"),list:()=>N(`- `)};o.querySelectorAll(`[data-md-insert]`).forEach(e=>{let t=e.dataset.mdInsert??``,n=I[t];n&&e.addEventListener(`click`,n)});let L=o.querySelector(`[data-md-clear]`);L&&L.addEventListener(`click`,()=>{f.value=``,j()}),T&&T.addEventListener(`click`,()=>{P(k,T)}),E&&E.addEventListener(`click`,()=>{P(f.value,E)}),D&&D.addEventListener(`click`,F);let R=!1,z=!1;f.addEventListener(`scroll`,()=>{if(!h||!h.checked||R)return;z=!0;let e=f.scrollHeight-f.clientHeight,t=e>0?f.scrollTop/e:0;p.scrollTop=t*(p.scrollHeight-p.clientHeight),requestAnimationFrame(()=>{z=!1})}),p.addEventListener(`scroll`,()=>{if(!h||!h.checked||z)return;R=!0;let e=p.scrollHeight-p.clientHeight,t=e>0?p.scrollTop/e:0;f.scrollTop=t*(f.scrollHeight-f.clientHeight),requestAnimationFrame(()=>{R=!1})}),x&&n(x,()=>r(f,c.example)),C().catch(()=>{}).finally(()=>{j()})}document.readyState===`loading`?document.addEventListener(`DOMContentLoaded`,T,{once:!0}):T();