/* global document, window, Blob, URL */

(function () {
    const initializedRoots = new WeakSet();

    const loremWords = [
        'lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit',
        'sed', 'do', 'eiusmod', 'tempor', 'incididunt', 'ut', 'labore', 'et', 'dolore',
        'magna', 'aliqua', 'enim', 'ad', 'minim', 'veniam', 'quis', 'nostrud',
        'exercitation', 'ullamco', 'laboris', 'nisi', 'aliquip', 'ex', 'ea', 'commodo',
        'consequat', 'duis', 'aute', 'irure', 'in', 'reprehenderit', 'voluptate',
        'velit', 'esse', 'cillum', 'fugiat', 'nulla', 'pariatur', 'excepteur', 'sint',
        'occaecat', 'cupidatat', 'non', 'proident', 'sunt', 'culpa', 'qui', 'officia',
        'deserunt', 'mollit', 'anim', 'id', 'est', 'laborum', 'vivamus', 'suspendisse',
        'potenti', 'nullam', 'ac', 'tortor', 'vitae', 'purus', 'faucibus', 'ornare',
        'luctus', 'cum', 'sociis', 'natoque', 'penatibus', 'magnis', 'dis', 'parturient',
        'montes', 'nascetur', 'ridiculus', 'mus', 'donec', 'quam', 'felis', 'ultricies',
        'nec', 'pellentesque', 'eu', 'pretium', 'sem', 'nulla', 'consequat', 'massa',
        'quis', 'enim', 'etiam', 'rhoncus', 'mauris', 'erat', 'volutpat', 'maecenas',
        'tempus', 'tellus', 'eget', 'condimentum', 'nibh', 'pulvinar', 'sapien', 'ligula',
        'venenatis', 'lacus', 'vel', 'scelerisque', 'nisl', 'consectetur', 'pede',
        'metus', 'mollis', 'justo', 'iaculis', 'porttitor', 'lacinia', 'posuere',
        'cubilia', 'curae', 'proin', 'blandit', 'odio', 'sodales', 'tincidunt',
        'integer', 'ante', 'dapibus', 'augue', 'facilisis', 'gravida', 'neque',
        'convallis', 'morbi', 'vestibulum', 'velit', 'id', 'pretium', 'iaculis',
        'diam', 'erat', 'fermentum', 'justo', 'nec', 'sagittis', 'aliquam',
        'malesuada', 'bibendum', 'arcu', 'elementum', 'cursus', 'turpis', 'massa',
        'tincidunt', 'dui', 'tempus', 'viverra', 'accumsan', 'tortor', 'urna',
        'habitant', 'tristique', 'senectus', 'netus', 'fames', 'nisl', 'suscipit',
        'adipiscing', 'bibendum', 'est', 'ultricies', 'integer', 'quis', 'auctor'
    ];

    const classicStart = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.';

    function getElements() {
        const root = document.getElementById('lorem-ipsum-root');
        if (!root) return null;

        return {
            root,
            generateBtn: document.getElementById('generate-btn'),
            copyBtn: document.getElementById('copy-btn'),
            downloadBtn: document.getElementById('download-btn'),
            output: document.getElementById('output'),
            type: document.getElementById('generate-type'),
            count: document.getElementById('count'),
            format: document.getElementById('output-format'),
            startClassic: document.getElementById('start-classic'),
            richOptions: document.getElementById('rich-options'),
            stats: document.getElementById('stats'),
            checkboxes: {
                headers: document.getElementById('include-headers'),
                lists: document.getElementById('include-lists'),
                formatting: document.getElementById('include-formatting'),
                links: document.getElementById('include-links'),
                code: document.getElementById('include-code')
            }
        };
    }

    // Helper functions
    function getRandomWord() {
        return loremWords[Math.floor(Math.random() * loremWords.length)];
    }

    function capitalize(str) {
        return str.charAt(0).toUpperCase() + str.slice(1);
    }

    function generateSentence(min = 5, max = 15) {
        const count = Math.floor(Math.random() * (max - min + 1)) + min;
        const words = [];
        for (let i = 0; i < count; i++) words.push(getRandomWord());
        return capitalize(words.join(' ')) + '.';
    }

    function generateParagraph(min = 3, max = 7) {
        const count = Math.floor(Math.random() * (max - min + 1)) + min;
        const sentences = [];
        for (let i = 0; i < count; i++) sentences.push(generateSentence());
        return sentences.join(' ');
    }

    function formatRichText(text, format, options) {
        const words = text.split(' ');
        
        // Bold/Italic
        if (options.formatting) {
            for (let i = 0; i < words.length; i++) {
                if (Math.random() < 0.05) { // 5% chance
                    const type = Math.random() > 0.5 ? 'strong' : 'em';
                    if (format === 'html') {
                        words[i] = `<${type}>${words[i]}</${type}>`;
                    } else if (format === 'markdown') {
                        const wrap = type === 'strong' ? '**' : '*';
                        words[i] = `${wrap}${words[i]}${wrap}`;
                    }
                }
            }
        }

        // Links
        if (options.links) {
            for (let i = 0; i < words.length; i++) {
                if (Math.random() < 0.03 && !words[i].includes('<') && !words[i].includes('*')) {
                    if (format === 'html') {
                        words[i] = `<a href="#">${words[i]}</a>`;
                    } else if (format === 'markdown') {
                        words[i] = `[${words[i]}](#)`;
                    }
                }
            }
        }

        return words.join(' ');
    }

    function generate(els) {
        if (!els) return;

        const type = els.type.value;
        const count = parseInt(els.count.value) || 5;
        const format = els.format.value;
        const startClassic = els.startClassic.checked;
        const options = {
            headers: els.checkboxes.headers.checked,
            lists: els.checkboxes.lists.checked,
            formatting: els.checkboxes.formatting.checked,
            links: els.checkboxes.links.checked,
            code: els.checkboxes.code.checked
        };

        // Update UI visibility
        const showRich = (type === 'paragraphs') && (format === 'html' || format === 'markdown');
        // els.richOptions.style.display = showRich ? 'block' : 'none'; // Replaced by detailed logic below

        if (format === 'plain') {
            els.richOptions.style.display = 'none';
        } else if (type !== 'paragraphs') {
            // Only show formatting/links for non-paragraphs
            Array.from(els.richOptions.children).forEach(child => {
                const input = child.querySelector('input');
                if (input && (input.id === 'include-formatting' || input.id === 'include-links')) {
                    child.style.display = 'block';
                } else {
                    child.style.display = 'none';
                }
            });
            els.richOptions.style.display = 'block';
        } else {
            // Show all for paragraphs
            Array.from(els.richOptions.children).forEach(c => c.style.display = 'block');
            els.richOptions.style.display = 'block';
        }

        let items = [];
        let rawText = '';

        // Generator Core
        if (type === 'words') {
            let words = [];
            if (startClassic) {
                words = classicStart.replace('.', '').toLowerCase().replace(',', '').split(' ');
            }
            while (words.length < count) {
                words.push(getRandomWord());
            }
            words = words.slice(0, count);
            rawText = words.join(' ');
            
            if (format !== 'plain') {
                rawText = formatRichText(rawText, format, options);
            }
            items.push(rawText);
        } else if (type === 'sentences') {
            let c = count;
            if (startClassic) {
                items.push(classicStart);
                c--;
            }
            for (let i = 0; i < c; i++) {
                let sent = generateSentence();
                if (format !== 'plain') sent = formatRichText(sent, format, options);
                items.push(sent);
            }
        } else if (type === 'list-items') {
            let c = count;
            for (let i = 0; i < c; i++) {
                let sent = generateSentence(3, 8).replace('.', ''); // shorter sentences
                if (format !== 'plain') sent = formatRichText(sent, format, options);
                items.push(sent);
            }
        } else { // paragraphs
            let c = count;
            if (startClassic) {
                let p = classicStart + ' ' + generateParagraph();
                if (format !== 'plain') p = formatRichText(p, format, options);
                items.push(p);
                c--;
            }
            
            for (let i = 0; i < c; i++) {
                let p = generateParagraph();
                if (format !== 'plain') p = formatRichText(p, format, options);
                items.push(p);

                // Inject headers/lists/code occasionally if allowed
                if (format !== 'plain' && i < c - 1) { // not after last
                    if (options.headers && Math.random() < 0.2) {
                        const h = generateSentence(3, 6).replace('.', '');
                        items.push({ type: 'header', content: h });
                    }
                    if (options.lists && Math.random() < 0.15) {
                        const lItems = [];
                        for(let j=0; j<3; j++) lItems.push(generateSentence(2,5).replace('.',''));
                        items.push({ type: 'list', content: lItems });
                    }
                    if (options.code && Math.random() < 0.1) {
                        items.push({ type: 'code', content: 'console.log("Lorem ipsum");' });
                    }
                }
            }
        }

        // Output Formatting
        let outputText = '';
        
        if (type === 'list-items') {
            if (format === 'html') {
                outputText = '<ul>\n' + items.map(i => `  <li>${i}</li>`).join('\n') + '\n</ul>';
            } else if (format === 'markdown') {
                outputText = items.map(i => `- ${i}`).join('\n');
            } else {
                outputText = items.join('\n');
            }
        } else if (type === 'paragraphs') {
            if (format === 'plain') {
                outputText = items.join('\n\n');
            } else {
                // HTML/MD
                outputText = items.map(item => {
                    if (typeof item === 'string') {
                        return format === 'html' ? `<p>${item}</p>` : `${item}`; // MD paragraphs just text separated by newline
                    } else {
                        // Special blocks
                        if (item.type === 'header') {
                            return format === 'html' ? `<h2>${item.content}</h2>` : `## ${item.content}`;
                        } else if (item.type === 'list') {
                            if (format === 'html') {
                                return `<ul>\n${item.content.map(li => `  <li>${li}</li>`).join('\n')}\n</ul>`;
                            } else {
                                return item.content.map(li => `- ${li}`).join('\n');
                            }
                        } else if (item.type === 'code') {
                            return format === 'html' ? `<pre><code>${item.content}</code></pre>` : "```javascript\n" + item.content + "\n```";
                        }
                    }
                    return '';
                }).join('\n\n');
            }
        } else {
            outputText = items.join(type === 'words' ? ' ' : ' ');
        }

        els.output.value = outputText;
        
        // Stats
        const wordCount = outputText.split(/\s+/).filter(w => w.length > 0).length;
        const charCount = outputText.length;
        els.stats.textContent = `${wordCount} words, ${charCount} characters`;
    }

    async function copyToClipboard(button, text) {
        try {
            await navigator.clipboard.writeText(text);
            const original = button.innerHTML;
            
            button.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5 text-success">
                    <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                </svg>
            `;
            button.classList.add('text-success');
            
            setTimeout(() => {
                button.innerHTML = original;
                button.classList.remove('text-success');
            }, 1500);
        } catch (err) {
            console.error('Failed to copy', err);
        }
    }

    function downloadFile(text) {
        const blob = new Blob([text], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'lorem-ipsum.txt';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    function bindDelegatedHandlersOnce() {
        if (window.__loremIpsumGeneratorBound) return;
        window.__loremIpsumGeneratorBound = true;

        document.addEventListener('click', (ev) => {
            const target = ev.target;
            if (!(target instanceof HTMLElement)) return;

            const genBtn = target.closest('#generate-btn');
            if (genBtn) {
                const els = getElements();
                if (els) generate(els);
                return;
            }

            const copyBtn = target.closest('#copy-btn');
            if (copyBtn) {
                const els = getElements();
                if (els) copyToClipboard(copyBtn, els.output.value);
                return;
            }

            const dlBtn = target.closest('#download-btn');
            if (dlBtn) {
                const els = getElements();
                if (els) downloadFile(els.output.value);
                return;
            }
        });

        // Use 'input' or 'change' for controls
        document.addEventListener('change', (ev) => {
            const target = ev.target;
            // Check if target is one of our controls
            const els = getElements();
            if (!els) return;

            if (target === els.type || 
                target === els.format || 
                target === els.count || 
                target === els.startClassic || 
                Object.values(els.checkboxes).includes(target)) {
                
                generate(els);
            }
        });
        
        // Also listen to input for count
        document.addEventListener('input', (ev) => {
            if (ev.target.id === 'count') {
                const els = getElements();
                if (els) generate(els);
            }
        });
    }

    function init() {
        const els = getElements();
        if (!els || initializedRoots.has(els.root)) return;
        initializedRoots.add(els.root);

        generate(els);
    }

    bindDelegatedHandlersOnce();
    
    document.addEventListener('DOMContentLoaded', init);
    document.addEventListener('enhancedload', init);

    const observer = new MutationObserver(() => init());
    observer.observe(document.body, { childList: true, subtree: true });

})();
