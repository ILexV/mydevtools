(function() {
    'use strict';

    let currentOriginalContent = '';
    let currentModifiedContent = '';

    function createDiff(original, modified) {
        // Use 'jsdiff' library (loaded from CDN as 'Diff') to create a standard Unified Diff
        if (typeof Diff === 'undefined') {
            console.error('jsdiff library not loaded');
            return null;
        }

        // createTwoFilesPatch(oldFileName, newFileName, oldStr, newStr, oldHeader, newHeader, options)
        // We leave headers empty or generic to cleaner UI
        const patch = Diff.createTwoFilesPatch(
            'Original', 
            'Modified', 
            original, 
            modified, 
            '', 
            ''
        );

        return patch;
    }

    function renderDiff() {
        const outputEl = document.getElementById('diff-output');
        const viewModeRadios = document.getElementsByName('diff-view-mode');
        let viewMode = 'side-by-side'; // Default to side-by-side
        
        for (const radio of viewModeRadios) {
            if (radio.checked) {
                viewMode = radio.value;
                break;
            }
        }
        
        if (!outputEl) return;
        
        if (!currentOriginalContent && !currentModifiedContent) {
            outputEl.innerHTML = '';
            outputEl.classList.add('hidden');
            return;
        }
        
        outputEl.classList.remove('hidden');
        
        const diffString = createDiff(currentOriginalContent, currentModifiedContent);
        
        if (!diffString) {
            outputEl.innerHTML = '<div class="alert alert-error">Diff library missing. Please refresh.</div>';
            return;
        }

        const configuration = {
            drawFileList: false,
            matching: 'lines',
            outputFormat: viewMode,
            highlight: true,
            renderNothingWhenEmpty: false,
            // Optimization for large diffs
            diffMaxChanges: 1000, 
            diffMaxLineLength: 1000,
        };
        
        outputEl.innerHTML = '';
        
        if (typeof Diff2HtmlUI !== 'undefined') {
            const diff2htmlUi = new Diff2HtmlUI(outputEl, diffString, configuration);
            diff2htmlUi.draw();
            
            try {
                diff2htmlUi.highlightCode();
            } catch (e) {
                console.warn("Syntax highlighting failed", e);
            }
        } else {
            outputEl.innerHTML = '<div class="alert alert-error">Diff2Html library failed to load. Please refresh.</div>';
        }
    }

    function init() {
        const root = document.getElementById('text-diff-viewer-root');
        if (!root) return;

        const originalTextArea = document.getElementById('diff-original-text');
        const modifiedTextArea = document.getElementById('diff-modified-text');
        const originalFileInput = document.getElementById('diff-original-file');
        const modifiedFileInput = document.getElementById('diff-modified-file');
        const compareBtn = document.getElementById('diff-compare-btn');
        const clearBtn = document.getElementById('diff-clear-btn');
        const viewModeRadios = document.getElementsByName('diff-view-mode');

        if (!originalTextArea || !modifiedTextArea) return;

        // Sync local state
        currentOriginalContent = originalTextArea.value;
        currentModifiedContent = modifiedTextArea.value;

        // View Mode Toggle
        viewModeRadios.forEach(radio => {
            radio.addEventListener('change', () => {
                if (currentOriginalContent || currentModifiedContent) {
                    renderDiff();
                }
            });
        });

        // File Loading Helper
        const handleFile = (input, textarea, isOriginal) => {
            if (input) {
                input.addEventListener('change', (e) => {
                    const file = e.target.files[0];
                    if (file) {
                        const reader = new FileReader();
                        reader.onload = (e) => {
                            const text = e.target.result;
                            textarea.value = text;
                            if (isOriginal) currentOriginalContent = text;
                            else currentModifiedContent = text;

                            // Auto-trigger if both present
                            if (currentOriginalContent && currentModifiedContent) {
                                renderDiff();
                            }
                        };
                        reader.readAsText(file);
                    }
                });
            }
        };

        handleFile(originalFileInput, originalTextArea, true);
        handleFile(modifiedFileInput, modifiedTextArea, false);

        // Compare Button
        if (compareBtn) {
            compareBtn.addEventListener('click', () => {
                currentOriginalContent = originalTextArea.value;
                currentModifiedContent = modifiedTextArea.value;
                renderDiff();
            });
        }

        // Clear Button
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                originalTextArea.value = '';
                modifiedTextArea.value = '';
                currentOriginalContent = '';
                currentModifiedContent = '';
                if (originalFileInput) originalFileInput.value = '';
                if (modifiedFileInput) modifiedFileInput.value = '';
                
                const outputEl = document.getElementById('diff-output');
                if (outputEl) {
                    outputEl.innerHTML = '';
                    outputEl.classList.add('hidden');
                }
            });
        }
    }

    document.addEventListener('DOMContentLoaded', init);
    document.addEventListener('enhancedload', init);
    
    // Initial call
    init();

})();
