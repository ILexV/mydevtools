(function () {
    'use strict';

    const initializedRoots = new WeakSet();

    function getElements() {
        const root = document.getElementById('word-counter-root');
        if (!root) return null;

        const inputText = document.getElementById('wc-input-text');
        const statWords = document.getElementById('wc-stat-words');
        const statCharsWith = document.getElementById('wc-stat-chars-with');
        const statCharsWithout = document.getElementById('wc-stat-chars-without');
        const statLines = document.getElementById('wc-stat-lines');
        const statParagraphs = document.getElementById('wc-stat-paragraphs');
        const statSentences = document.getElementById('wc-stat-sentences');
        const readingTime = document.getElementById('wc-reading-time');
        const speakingTime = document.getElementById('wc-speaking-time');

        if (!inputText || !statWords || !statCharsWith || !statCharsWithout || 
            !statLines || !statParagraphs || !statSentences || !readingTime || !speakingTime) {
            return null;
        }

        return { 
            root, 
            inputText, 
            statWords, 
            statCharsWith, 
            statCharsWithout, 
            statLines, 
            statParagraphs, 
            statSentences,
            readingTime,
            speakingTime
        };
    }

    function countTextStats(text) {
        const trimmedText = text.trim();
        
        // Characters
        const charsWithSpaces = text.length;
        const charsWithoutSpaces = text.replace(/\s/g, '').length;
        
        // Lines (split by newlines, but if empty string, return 0)
        const lines = text === '' ? 0 : text.split(/\r?\n/).length;
        
        // Paragraphs (split by double newlines or more)
        const paragraphs = trimmedText === '' ? 0 : trimmedText.split(/\n\s*\n/).length;
        
        // Sentences (split by sentence-ending punctuation)
        const sentenceMatches = trimmedText.match(/[.!?]+/g);
        const sentences = sentenceMatches ? sentenceMatches.length : 0;
        
        // Words
        const words = trimmedText === '' ? 0 : trimmedText.split(/\s+/).filter(word => word.length > 0).length;
        
        return {
            charsWithSpaces,
            charsWithoutSpaces,
            lines,
            paragraphs,
            sentences,
            words
        };
    }

    function formatTime(minutes) {
        if (minutes < 1) {
            const seconds = Math.round(minutes * 60);
            return `${seconds}s`;
        } else if (minutes < 60) {
            const mins = Math.floor(minutes);
            const secs = Math.round((minutes - mins) * 60);
            return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
        } else {
            const hours = Math.floor(minutes / 60);
            const mins = Math.floor(minutes % 60);
            return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
        }
    }

    function updateStats() {
        const els = getElements();
        if (!els) return;

        const text = els.inputText.value;
        const stats = countTextStats(text);

        // Update stats with animation
        animateValue(els.statWords, parseInt(els.statWords.textContent) || 0, stats.words);
        animateValue(els.statCharsWith, parseInt(els.statCharsWith.textContent) || 0, stats.charsWithSpaces);
        animateValue(els.statCharsWithout, parseInt(els.statCharsWithout.textContent) || 0, stats.charsWithoutSpaces);
        animateValue(els.statLines, parseInt(els.statLines.textContent) || 0, stats.lines);
        animateValue(els.statParagraphs, parseInt(els.statParagraphs.textContent) || 0, stats.paragraphs);
        animateValue(els.statSentences, parseInt(els.statSentences.textContent) || 0, stats.sentences);

        // Reading time: average 200 words per minute
        const readingMinutes = stats.words / 200;
        els.readingTime.textContent = formatTime(readingMinutes);

        // Speaking time: average 130 words per minute
        const speakingMinutes = stats.words / 130;
        els.speakingTime.textContent = formatTime(speakingMinutes);
    }

    function animateValue(element, start, end) {
        if (start === end) return;
        
        const duration = 200;
        const startTime = performance.now();
        
        function update(currentTime) {
            const elapsed = currentTime - startTime;
            const progress = Math.min(elapsed / duration, 1);
            const easeProgress = 1 - Math.pow(1 - progress, 3); // Ease-out cubic
            
            const current = Math.round(start + (end - start) * easeProgress);
            element.textContent = current.toLocaleString();
            
            if (progress < 1) {
                requestAnimationFrame(update);
            }
        }
        
        requestAnimationFrame(update);
    }

    async function handleCopy() {
        const els = getElements();
        if (!els || !els.inputText) return;

        const text = els.inputText.value;
        if (!text) return;

        try {
            await navigator.clipboard.writeText(text);
            showToast(els.root.dataset.copied || 'Copied!');
        } catch (err) {
            console.error('Copy error:', err);
        }
    }

    async function handlePaste() {
        const els = getElements();
        if (!els || !els.inputText) return;

        try {
            const text = await navigator.clipboard.readText();
            els.inputText.value = text;
            updateStats();
            showToast('Pasted!');
        } catch (err) {
            console.error('Paste error:', err);
        }
    }

    function handleClear() {
        const els = getElements();
        if (!els || !els.inputText) return;
        
        els.inputText.value = '';
        updateStats();
        els.inputText.focus();
    }

    function showToast(message) {
        const existing = document.querySelector('.wc-toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.className = 'wc-toast alert alert-success fixed bottom-4 right-4 z-50 shadow-lg';
        toast.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" class="stroke-current shrink-0 h-6 w-6" fill="none" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>${message}</span>
        `;
        document.body.appendChild(toast);

        setTimeout(() => toast.remove(), 2000);
    }

    function bindDelegatedHandlersOnce() {
        if (window.__mydevtools_wordcounter_bound) return;
        window.__mydevtools_wordcounter_bound = true;

        document.addEventListener('click', (ev) => {
            const target = ev.target;
            if (!(target instanceof HTMLElement)) return;

            // Copy button
            if (target.closest('#wc-copy-btn')) {
                ev.preventDefault();
                void handleCopy();
                return;
            }

            // Clear button
            if (target.closest('#wc-clear-btn')) {
                ev.preventDefault();
                handleClear();
                return;
            }

            // Paste button
            if (target.closest('#wc-paste-btn')) {
                ev.preventDefault();
                void handlePaste();
                return;
            }
        });
    }

    function initIfPresent() {
        const els = getElements();
        if (!els) return;
        if (initializedRoots.has(els.root)) return;
        
        initializedRoots.add(els.root);
        bindDelegatedHandlersOnce();

        // Bind input event for real-time updates
        els.inputText.addEventListener('input', updateStats);
        
        // Initial stats update
        updateStats();
    }

    // Initialize immediately
    initIfPresent();

    // Watch for DOM changes (for Blazor navigation)
    try {
        const observer = new MutationObserver(() => {
            initIfPresent();
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch {
        // ignore
    }
})();
