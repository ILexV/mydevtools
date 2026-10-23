import{a as e,f as t,i as n,l as r,r as i}from"./tool-ui.f-GKGTTL.js";import{n as a,t as o}from"./markdown-sanitize.Cm5w9VOC.js";import{t as s}from"./automatic-use.BojE17Ue.js";var c={breaks:!0,gfm:!0,headerIds:!0,mangle:!1},l=`/`.replace(/\/$/,``),u=null;function d(){return window.marked?Promise.resolve():(u||=new Promise((e,t)=>{let n=`${l}/lib/marked.min.js`,r=document.querySelector(`script[src="${n}"]`);if(r){if(r.dataset.loaded===`true`){e();return}r.addEventListener(`load`,()=>e(),{once:!0}),r.addEventListener(`error`,()=>t(Error(`Failed to load ${n}`)),{once:!0});return}let i=document.createElement(`script`);i.src=n,i.async=!1,i.addEventListener(`load`,()=>{i.dataset.loaded=`true`,e()},{once:!0}),i.addEventListener(`error`,()=>{i.remove(),t(Error(`Failed to load ${n}`))},{once:!0}),document.body.appendChild(i)}).catch(e=>{throw u=null,e}),u)}function f(){let e=document.querySelector(`[data-md-strings]`);if(!e)return null;try{return JSON.parse(e.textContent||`{}`)}catch{return null}}function p(){let l=document.querySelector(`[data-md-tool]`);if(!l)return;let u=f();if(!u)return;let p=u,m=l.querySelector(`[data-md-input]`),h=l.querySelector(`[data-md-output]`),g=l.querySelector(`[data-md-error]`);if(!m||!h||!g)return;let _=m,v=h,y=g,b=l.querySelector(`[data-md-sync-scroll]`),x=l.querySelector(`[data-md-input-host]`),S=l.querySelector(`[data-md-output-panel]`),C=l.querySelector(`[data-md-example]`),w=x?i(x,_):()=>{},T=l.querySelector(`[data-md-copy-html]`),E=l.querySelector(`[data-md-copy-md]`),D=l.querySelector(`[data-md-download]`);function O(){let e=_.value.trim()===``;for(let t of[T,E,D])t&&(t.disabled=e)}let k=``,A=s(`markdown-preview`);function j(e=!1){w(),S&&t(S,_.value===``),O();let n=e&&_.value.trim()?A.start():null;try{if(window.marked){let e=a(window.marked.parse(_.value,c)),t=document.createElement(`div`);t.append(e.cloneNode(!0)),k=t.innerHTML,o(e),v.replaceChildren(e)}else{k=``,v.textContent=``;let e=document.createElement(`p`);e.className=`md-lib-error`,e.textContent=p.markedLoadFailed,v.appendChild(e)}y.hidden=!0,window.marked?n?.complete():n?.fail(`processing_error`)}catch(e){let t=e instanceof Error?e.message:String(e);y.textContent=p.renderError.replace(`{message}`,t),y.hidden=!1,n?.fail(`invalid_input`)}}function M(e,t=``){let n=_.selectionStart,r=_.selectionEnd,i=_.value.substring(n,r),a=e+i+t;_.value=_.value.substring(0,n)+a+_.value.substring(r);let o=n+e.length+i.length;_.setSelectionRange(o,o),_.focus(),A.changed(),j(!0)}function N(e){let t=_.selectionStart,n=_.value.split(`
`),r=0,i=0;for(let e=0;e<n.length;e++){let a=n[e]??``;if(r+a.length>=t){i=e;break}r+=a.length+1}n[i]=e+(n[i]??``),_.value=n.join(`
`);let a=t+e.length;_.setSelectionRange(a,a),_.focus(),A.changed(),j(!0)}async function P(t,n){await e(n,t,p.copied)||(y.textContent=p.copyFailed,y.hidden=!1)}function F(){let e=`<!DOCTYPE html>
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
</html>`,t=new Blob([e],{type:`text/html`}),n=URL.createObjectURL(t),r=document.createElement(`a`);r.href=n,r.download=`markdown-preview.html`,r.click(),URL.revokeObjectURL(n)}_.addEventListener(`input`,e=>{if(!e.isTrusted){j();return}A.changed(),window.marked?j(!0):d().catch(()=>void 0).finally(()=>j(!0))});let I={bold:()=>M(`**`,`**`),italic:()=>M(`*`,`*`),heading:()=>N(`## `),link:()=>M(`[`,`](url)`),image:()=>M(`![alt text](`,`)`),code:()=>M("`","`"),list:()=>N(`- `)};l.querySelectorAll(`[data-md-insert]`).forEach(e=>{let t=e.dataset.mdInsert??``,n=I[t];n&&e.addEventListener(`click`,n)});let L=l.querySelector(`[data-md-clear]`);L&&L.addEventListener(`click`,()=>{_.value=``,j()}),T&&T.addEventListener(`click`,()=>{P(k,T)}),E&&E.addEventListener(`click`,()=>{P(_.value,E)}),D&&D.addEventListener(`click`,F);let R=!1,z=!1;_.addEventListener(`scroll`,()=>{if(!b||!b.checked||R)return;z=!0;let e=_.scrollHeight-_.clientHeight,t=e>0?_.scrollTop/e:0;v.scrollTop=t*(v.scrollHeight-v.clientHeight),requestAnimationFrame(()=>{z=!1})}),v.addEventListener(`scroll`,()=>{if(!b||!b.checked||z)return;R=!0;let e=v.scrollHeight-v.clientHeight,t=e>0?v.scrollTop/e:0;_.scrollTop=t*(_.scrollHeight-_.clientHeight),requestAnimationFrame(()=>{R=!1})}),C&&n(C,()=>r(_,p.example)),d().catch(()=>{}).finally(()=>{j()})}document.readyState===`loading`?document.addEventListener(`DOMContentLoaded`,p,{once:!0}):p();