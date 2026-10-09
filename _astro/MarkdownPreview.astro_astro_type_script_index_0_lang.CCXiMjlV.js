import{a as e,f as t,i as n,l as r,r as i}from"./tool-ui.bHiPSqdl.js";var a=new Set(`a.abbr.b.blockquote.br.caption.cite.code.col.colgroup.dd.del.details.dfn.div.dl.dt.em.figcaption.figure.h1.h2.h3.h4.h5.h6.hr.i.img.input.ins.kbd.li.mark.ol.p.pre.q.rp.rt.ruby.s.samp.small.span.strong.sub.summary.sup.table.tbody.td.tfoot.th.thead.time.tr.u.ul.var.wbr`.split(`.`)),o=new Set(`script.style.iframe.frame.frameset.object.embed.applet.template.noscript.noembed.noframes.xmp.plaintext.svg.math.form.textarea.select.option.button.link.meta.base.title.head.audio.video.source.track.canvas.portal.dialog`.split(`.`)),s=new Set([`title`,`lang`,`dir`]),c={a:new Set([`href`]),img:new Set([`src`,`alt`,`width`,`height`]),td:new Set([`align`,`colspan`,`rowspan`]),th:new Set([`align`,`colspan`,`rowspan`,`scope`]),col:new Set([`span`]),colgroup:new Set([`span`]),ol:new Set([`start`,`reversed`]),li:new Set([`value`]),details:new Set([`open`]),input:new Set([`type`,`checked`,`disabled`]),time:new Set([`datetime`]),q:new Set([`cite`]),blockquote:new Set([`cite`])},l=new Set([`http`,`https`,`mailto`,`tel`]),u=/^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,[a-z0-9+/=\s]*$/i;function d(e,t){let n=e.replace(/[\u0000- \u007f-\u009f]/g,``),r=/^([a-z][a-z0-9+.-]*):/i.exec(n)?.[1]?.toLowerCase();return r===void 0?!0:t===`src`?r===`http`||r===`https`||r===`data`&&u.test(n):l.has(r)}function f(e,t,n){return t.startsWith(`on`)?!1:t===`class`?e===`code`&&/^language-[\w+#.-]+$/.test(n.trim()):t===`href`||t===`cite`?(c[e]?.has(t)??!1)&&d(n,`href`):t===`src`?e===`img`&&d(n,`src`):e===`input`&&t===`type`?n.toLowerCase()===`checkbox`:s.has(t)||(c[e]?.has(t)??!1)}function p(e){return o.has(e)?`drop`:a.has(e)?`keep`:`unwrap`}function m(e){let t=e.localName;for(let n of Array.from(e.attributes))f(t,n.name.toLowerCase(),n.value)||e.removeAttribute(n.name);if(t===`input`){if(e.getAttribute(`type`)?.toLowerCase()!==`checkbox`){e.remove();return}e.setAttribute(`disabled`,``)}t===`a`&&e.hasAttribute(`href`)&&(e.setAttribute(`target`,`_blank`),e.setAttribute(`rel`,`noopener noreferrer nofollow`))}function h(e){for(let t of Array.from(e.childNodes)){if(t.nodeType===8){t.remove();continue}if(t.nodeType!==1)continue;let e=t;if(e.namespaceURI!==`http://www.w3.org/1999/xhtml`){e.remove();continue}let n=p(e.localName);if(n===`drop`){e.remove();continue}if(h(e),n===`unwrap`){e.replaceWith(...Array.from(e.childNodes));continue}m(e)}}function g(e,t=document){let n=t.createElement(`template`);return n.innerHTML=e,h(n.content),n.content}function _(e){return Math.min(Math.max(e,1),6)+1}function v(e,t=document){for(let n of Array.from(e.querySelectorAll(`h1, h2, h3, h4, h5, h6`))){let e=Number(n.tagName.charAt(1)),r=_(e),i=r<=6?t.createElement(`h${r}`):t.createElement(`div`);r>6&&(i.setAttribute(`role`,`heading`),i.setAttribute(`aria-level`,String(r))),i.className=`md-h${e}`,i.append(...Array.from(n.childNodes)),n.replaceWith(i)}}var y={breaks:!0,gfm:!0,headerIds:!0,mangle:!1},b=`/`.replace(/\/$/,``),x=null;function S(){return window.marked?Promise.resolve():(x||=new Promise((e,t)=>{let n=`${b}/lib/marked.min.js`,r=document.querySelector(`script[src="${n}"]`);if(r){if(r.dataset.loaded===`true`){e();return}r.addEventListener(`load`,()=>e(),{once:!0}),r.addEventListener(`error`,()=>t(Error(`Failed to load ${n}`)),{once:!0});return}let i=document.createElement(`script`);i.src=n,i.async=!1,i.addEventListener(`load`,()=>{i.dataset.loaded=`true`,e()},{once:!0}),i.addEventListener(`error`,()=>{i.remove(),t(Error(`Failed to load ${n}`))},{once:!0}),document.body.appendChild(i)}).catch(e=>{throw x=null,e}),x)}function C(){let e=document.querySelector(`[data-md-strings]`);if(!e)return null;try{return JSON.parse(e.textContent||`{}`)}catch{return null}}function w(){let a=document.querySelector(`[data-md-tool]`);if(!a)return;let o=C();if(!o)return;let s=o,c=a.querySelector(`[data-md-input]`),l=a.querySelector(`[data-md-output]`),u=a.querySelector(`[data-md-error]`);if(!c||!l||!u)return;let d=c,f=l,p=u,m=a.querySelector(`[data-md-sync-scroll]`),h=a.querySelector(`[data-md-input-host]`),_=a.querySelector(`[data-md-output-panel]`),b=a.querySelector(`[data-md-example]`),x=h?i(h,d):()=>{},w=a.querySelector(`[data-md-copy-html]`),T=a.querySelector(`[data-md-copy-md]`),E=a.querySelector(`[data-md-download]`);function D(){let e=d.value.trim()===``;for(let t of[w,T,E])t&&(t.disabled=e)}let O=``;function k(){x(),_&&t(_,d.value===``),D();try{if(window.marked){let e=g(window.marked.parse(d.value,y)),t=document.createElement(`div`);t.append(e.cloneNode(!0)),O=t.innerHTML,v(e),f.replaceChildren(e)}else{O=``,f.textContent=``;let e=document.createElement(`p`);e.className=`md-lib-error`,e.textContent=s.markedLoadFailed,f.appendChild(e)}p.hidden=!0}catch(e){let t=e instanceof Error?e.message:String(e);p.textContent=s.renderError.replace(`{message}`,t),p.hidden=!1}}function A(e,t=``){let n=d.selectionStart,r=d.selectionEnd,i=d.value.substring(n,r),a=e+i+t;d.value=d.value.substring(0,n)+a+d.value.substring(r);let o=n+e.length+i.length;d.setSelectionRange(o,o),d.focus(),k()}function j(e){let t=d.selectionStart,n=d.value.split(`
`),r=0,i=0;for(let e=0;e<n.length;e++){let a=n[e]??``;if(r+a.length>=t){i=e;break}r+=a.length+1}n[i]=e+(n[i]??``),d.value=n.join(`
`);let a=t+e.length;d.setSelectionRange(a,a),d.focus(),k()}async function M(t,n){await e(n,t,s.copied)||(p.textContent=s.copyFailed,p.hidden=!1)}function N(){let e=`<!DOCTYPE html>
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
`+O+`
</body>
</html>`,t=new Blob([e],{type:`text/html`}),n=URL.createObjectURL(t),r=document.createElement(`a`);r.href=n,r.download=`markdown-preview.html`,r.click(),URL.revokeObjectURL(n)}d.addEventListener(`input`,()=>{window.marked?k():S().catch(()=>void 0).finally(k)});let P={bold:()=>A(`**`,`**`),italic:()=>A(`*`,`*`),heading:()=>j(`## `),link:()=>A(`[`,`](url)`),image:()=>A(`![alt text](`,`)`),code:()=>A("`","`"),list:()=>j(`- `)};a.querySelectorAll(`[data-md-insert]`).forEach(e=>{let t=e.dataset.mdInsert??``,n=P[t];n&&e.addEventListener(`click`,n)});let F=a.querySelector(`[data-md-clear]`);F&&F.addEventListener(`click`,()=>{d.value=``,k()}),w&&w.addEventListener(`click`,()=>{M(O,w)}),T&&T.addEventListener(`click`,()=>{M(d.value,T)}),E&&E.addEventListener(`click`,N);let I=!1,L=!1;d.addEventListener(`scroll`,()=>{if(!m||!m.checked||I)return;L=!0;let e=d.scrollHeight-d.clientHeight,t=e>0?d.scrollTop/e:0;f.scrollTop=t*(f.scrollHeight-f.clientHeight),requestAnimationFrame(()=>{L=!1})}),f.addEventListener(`scroll`,()=>{if(!m||!m.checked||L)return;I=!0;let e=f.scrollHeight-f.clientHeight,t=e>0?f.scrollTop/e:0;d.scrollTop=t*(d.scrollHeight-d.clientHeight),requestAnimationFrame(()=>{I=!1})}),b&&n(b,()=>r(d,s.example)),S().catch(()=>{}).finally(()=>{k()})}document.readyState===`loading`?document.addEventListener(`DOMContentLoaded`,w,{once:!0}):w();