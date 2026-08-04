var e={breaks:!0,gfm:!0,headerIds:!0,mangle:!1},t=`# Welcome to Markdown Preview

## Features

- **Live preview** as you type
- Support for **GitHub Flavored Markdown** (GFM)
- Code syntax highlighting
- Tables, lists, and more

### Example Code Block

\`\`\`javascript
function greet(name) {
    console.log(\`Hello, \${name}!\`);
}
\`\`\`

### Example Table

| Feature | Supported |
|---------|-----------|
| Headers | ✅ |
| Lists   | ✅ |
| Links   | ✅ |
| Images  | ✅ |

### Example Link

[Visit MyDevTools](https://mydevtools.app)

---

*Start typing in the editor to see your markdown rendered!*`,n=`/mydevtools/`.replace(/\/$/,``),r=null;function i(){return window.marked?Promise.resolve():(r||=new Promise((e,t)=>{let r=`${n}/lib/marked.min.js`,i=document.querySelector(`script[src="${r}"]`);if(i){if(i.dataset.loaded===`true`){e();return}i.addEventListener(`load`,()=>e(),{once:!0}),i.addEventListener(`error`,()=>t(Error(`Failed to load ${r}`)),{once:!0});return}let a=document.createElement(`script`);a.src=r,a.async=!1,a.addEventListener(`load`,()=>{a.dataset.loaded=`true`,e()},{once:!0}),a.addEventListener(`error`,()=>t(Error(`Failed to load ${r}`)),{once:!0}),document.body.appendChild(a)}).catch(e=>{throw r=null,e}),r)}function a(){let e=document.querySelector(`[data-md-strings]`);if(!e)return null;try{return JSON.parse(e.textContent||`{}`)}catch{return null}}function o(){let n=document.querySelector(`[data-md-tool]`);if(!n)return;let r=a();if(!r)return;let o=r,s=n.querySelector(`[data-md-input]`),c=n.querySelector(`[data-md-output]`),l=n.querySelector(`[data-md-error]`);if(!s||!c||!l)return;let u=s,d=c,f=l,p=n.querySelector(`[data-md-sync-scroll]`);function m(){try{if(window.marked)d.innerHTML=window.marked.parse(u.value,e);else{d.textContent=``;let e=document.createElement(`p`);e.className=`md-lib-error`,e.textContent=o.markedLoadFailed,d.appendChild(e)}f.hidden=!0}catch(e){let t=e instanceof Error?e.message:String(e);f.textContent=o.renderError.replace(`{message}`,t),f.hidden=!1}}function h(e,t=``){let n=u.selectionStart,r=u.selectionEnd,i=u.value.substring(n,r),a=e+i+t;u.value=u.value.substring(0,n)+a+u.value.substring(r);let o=n+e.length+i.length;u.setSelectionRange(o,o),u.focus(),m()}function g(e){let t=u.selectionStart,n=u.value.split(`
`),r=0,i=0;for(let e=0;e<n.length;e++){let a=n[e]??``;if(r+a.length>=t){i=e;break}r+=a.length+1}n[i]=e+(n[i]??``),u.value=n.join(`
`);let a=t+e.length;u.setSelectionRange(a,a),u.focus(),m()}async function _(e,t){try{await navigator.clipboard.writeText(e);let n=t.textContent;t.textContent=o.copied,window.setTimeout(()=>{t.textContent=n},1200)}catch{f.textContent=o.copyFailed,f.hidden=!1}}function v(){let e=`<!DOCTYPE html>
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
`+d.innerHTML+`
</body>
</html>`,t=new Blob([e],{type:`text/html`}),n=URL.createObjectURL(t),r=document.createElement(`a`);r.href=n,r.download=`markdown-preview.html`,r.click(),URL.revokeObjectURL(n)}u.addEventListener(`input`,m);let y={bold:()=>h(`**`,`**`),italic:()=>h(`*`,`*`),heading:()=>g(`## `),link:()=>h(`[`,`](url)`),image:()=>h(`![alt text](`,`)`),code:()=>h("`","`"),list:()=>g(`- `)};n.querySelectorAll(`[data-md-insert]`).forEach(e=>{let t=e.dataset.mdInsert??``,n=y[t];n&&e.addEventListener(`click`,n)});let b=n.querySelector(`[data-md-clear]`);b&&b.addEventListener(`click`,()=>{u.value=``,m()});let x=n.querySelector(`[data-md-copy-html]`);x&&x.addEventListener(`click`,()=>{_(d.innerHTML,x)});let S=n.querySelector(`[data-md-copy-md]`);S&&S.addEventListener(`click`,()=>{_(u.value,S)});let C=n.querySelector(`[data-md-download]`);C&&C.addEventListener(`click`,v);let w=!1,T=!1;u.addEventListener(`scroll`,()=>{if(!p||!p.checked||w)return;T=!0;let e=u.scrollHeight-u.clientHeight,t=e>0?u.scrollTop/e:0;d.scrollTop=t*(d.scrollHeight-d.clientHeight),requestAnimationFrame(()=>{T=!1})}),d.addEventListener(`scroll`,()=>{if(!p||!p.checked||T)return;w=!0;let e=d.scrollHeight-d.clientHeight,t=e>0?d.scrollTop/e:0;u.scrollTop=t*(u.scrollHeight-u.clientHeight),requestAnimationFrame(()=>{w=!1})}),u.value||=t,i().catch(()=>{}).finally(()=>{m()})}document.readyState===`loading`?document.addEventListener(`DOMContentLoaded`,o,{once:!0}):o();