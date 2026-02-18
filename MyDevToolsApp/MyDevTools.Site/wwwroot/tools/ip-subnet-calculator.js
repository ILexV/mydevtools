(function () {
    const initializedRoots = new WeakSet();
    let wasmModule = null;

    async function ensureWasmLoaded() {
        if (wasmModule) return wasmModule;
        try {
            // Use standard import pattern for lazy loaded WASM
            wasmModule = await import('../wasm/ipcalc/ipcalc.js');
            await wasmModule.default(); // Initialize WASM
            return wasmModule;
        } catch (err) {
            console.error('Failed to load WASM module:', err);
            return null;
        }
    }

    function getElements() {
        const root = document.getElementById('ip-calc-root');
        if (!root) return null;

        return {
            root,
            input: document.getElementById('cidr-input'),
            btn: document.getElementById('calculate-btn'),
            error: document.getElementById('input-error'),
            resultCard: document.getElementById('result-card'),
            
            // Result fields
            resIp: document.getElementById('res-ip'),
            resNetmask: document.getElementById('res-netmask'),
            resWildcard: document.getElementById('res-wildcard'),
            resNetwork: document.getElementById('res-network'),
            resPrefix: document.getElementById('res-prefix'),
            resBroadcast: document.getElementById('res-broadcast'),
            resHostMin: document.getElementById('res-host-min'),
            resHostMax: document.getElementById('res-host-max'),
            resUsableHosts: document.getElementById('res-usable-hosts'),
            resTotalHosts: document.getElementById('res-total-hosts'),
            resClass: document.getElementById('res-class'),
            resPrivate: document.getElementById('res-private'),
            resPublic: document.getElementById('res-public'),
            resIpBinary: document.getElementById('res-ip-binary'),
            resMaskBinary: document.getElementById('res-mask-binary'),
            
            // Data attributes
            msgInvalidFormat: root.dataset.errorInvalidFormat,
            msgCopied: root.dataset.copied
        };
    }

    async function calculate(els) {
        const input = els.input.value.trim();
        if (!input) return;

        els.error.classList.add('hidden');
        const wasm = await ensureWasmLoaded();
        if (!wasm) return;

        try {
            const result = wasm.calc_ipv4(input);
            
            // Populate fields
            els.resIp.textContent = result.ip;
            els.resNetmask.textContent = result.netmask;
            els.resWildcard.textContent = result.wildcard;
            els.resNetwork.textContent = result.network;
            els.resPrefix.textContent = '/' + result.prefix;
            els.resBroadcast.textContent = result.broadcast;
            els.resHostMin.textContent = result.host_min;
            els.resHostMax.textContent = result.host_max;
            els.resUsableHosts.textContent = result.usable_hosts.toLocaleString();
            els.resTotalHosts.textContent = result.total_hosts.toLocaleString();
            els.resClass.textContent = result.class;
            
            if (result.is_private) {
                els.resPrivate.classList.remove('hidden');
                els.resPublic.classList.add('hidden');
            } else {
                els.resPrivate.classList.add('hidden');
                els.resPublic.classList.remove('hidden');
            }

            els.resIpBinary.textContent = result.ip_binary;
            els.resMaskBinary.textContent = result.mask_binary;

            // Show results
            els.resultCard.style.display = 'block';

        } catch (e) {
            console.error(e);
            els.error.textContent = els.msgInvalidFormat || "Invalid format";
            els.error.classList.remove('hidden');
            els.resultCard.style.display = 'none';
        }
    }

    function initIfPresent() {
        const els = getElements();
        if (!els || initializedRoots.has(els.root)) return;
        initializedRoots.add(els.root);

        // Bind Calculate button
        els.btn.addEventListener('click', () => calculate(els));

        // Bind Enter key
        els.input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') calculate(els);
        });

        // Bind Example buttons
        els.root.querySelectorAll('[data-example]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                els.input.value = e.target.dataset.example;
                calculate(els);
            });
        });

        // Bind Copy buttons
        els.root.querySelectorAll('.copy-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const targetId = btn.dataset.target;
                const targetEl = document.getElementById(targetId);
                if (targetEl) {
                    navigator.clipboard.writeText(targetEl.textContent).then(() => {
                        const originalHtml = btn.innerHTML;
                        btn.innerHTML = `<span class="text-xs text-success">${els.msgCopied}</span>`;
                        setTimeout(() => btn.innerHTML = originalHtml, 2000);
                    });
                }
            });
        });
    }

    // Init on load
    initIfPresent();

    // Observe for navigation (Blazor SSR updates)
    new MutationObserver(() => initIfPresent())
        .observe(document.body, { childList: true, subtree: true });

})();
