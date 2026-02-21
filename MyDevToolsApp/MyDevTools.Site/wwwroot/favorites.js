// Favorites and Recent Tools management module for MyDevTools
// Handles storing/retrieving favorites and recent tools from localStorage and UI interactions

(function () {
    'use strict';

    const FAVORITES_KEY = 'mydevtools_favorites';
    const RECENT_KEY = 'mydevtools_recent';
    const MAX_RECENT_ITEMS = 10;

    // Tool registry - all available tools with their metadata
    // This should match the tools defined in Home.razor
    const TOOLS_REGISTRY = {
        'image-converter': { 
            name: { en: 'Image Converter', ru: 'Конвертер изображений', es: 'Conversor de Imágenes', de: 'Bildkonverter', pt: 'Conversor de Imagens', zh: '图像转换器', fr: 'Convertisseur d\'Images', ja: '画像変換', ko: '이미지 변환기', hi: 'छवि कनवर्टर' },
            icon: '🖼️', 
            popular: false 
        },
        'image-compressor': { 
            name: { en: 'Image Compressor', ru: 'Сжатие изображений', es: 'Compresor de Imágenes', de: 'Bildkomprimierer', pt: 'Compressor de Imagens', zh: '图像压缩器', fr: 'Compresseur d\'Images', ja: '画像圧縮', ko: '이미지 압축기', hi: 'छवि संपीड़क' },
            icon: '📉', 
            popular: false 
        },
        'image-resizer': { 
            name: { en: 'Image Resizer', ru: 'Изменение размера', es: 'Redimensionador', de: 'Bildgrößenänderer', pt: 'Redimensionador', zh: '图像调整器', fr: 'Redimensionneur', ja: '画像リサイズ', ko: '이미지 리사이저', hi: 'छवि आकार परिवर्तक' },
            icon: '📏', 
            popular: false 
        },
        'color-converter': { 
            name: { en: 'Color Converter', ru: 'Конвертер цветов', es: 'Conversor de Colores', de: 'Farbkonverter', pt: 'Conversor de Cores', zh: '颜色转换器', fr: 'Convertisseur de Couleurs', ja: 'カラー変換', ko: '색상 변환기', hi: 'रंग कनवर्टर' },
            icon: '🎨', 
            popular: true 
        },
        'markdown-preview': { 
            name: { en: 'Markdown Preview', ru: 'Markdown превью', es: 'Vista Previa Markdown', de: 'Markdown-Vorschau', pt: 'Pré-visualização', zh: 'Markdown预览', fr: 'Aperçu Markdown', ja: 'Markdownプレビュー', ko: '마크다운 미리보기', hi: 'मार्कडाउन पूर्वावलोकन' },
            icon: '📄', 
            popular: false 
        },
        'hash-calculator': { 
            name: { en: 'Hash Calculator', ru: 'Калькулятор хэшей', es: 'Calculadora Hash', de: 'Hash-Rechner', pt: 'Calculadora Hash', zh: '哈希计算器', fr: 'Calculateur de Hash', ja: 'ハッシュ計算', ko: '해시 계산기', hi: 'हैश कैलकुलेटर' },
            icon: '🔐', 
            popular: false 
        },
        'password-generator': { 
            name: { en: 'Password Generator', ru: 'Генератор паролей', es: 'Generador de Contraseñas', de: 'Passwort-Generator', pt: 'Gerador de Senhas', zh: '密码生成器', fr: 'Générateur de Mots de Passe', ja: 'パスワード生成', ko: '비밀번호 생성기', hi: 'पासवर्ड जनरेटर' },
            icon: '🎲', 
            popular: true 
        },
        'uuid-generator': { 
            name: { en: 'UUID Generator', ru: 'Генератор UUID', es: 'Generador UUID', de: 'UUID-Generator', pt: 'Gerador UUID', zh: 'UUID生成器', fr: 'Générateur UUID', ja: 'UUID生成', ko: 'UUID 생성기', hi: 'UUID जनरेटर' },
            icon: '🆔', 
            popular: true 
        },
        'lorem-ipsum-generator': { 
            name: { en: 'Lorem Ipsum', ru: 'Lorem Ipsum', es: 'Lorem Ipsum', de: 'Lorem Ipsum', pt: 'Lorem Ipsum', zh: 'Lorem Ipsum', fr: 'Lorem Ipsum', ja: 'Lorem Ipsum', ko: 'Lorem Ipsum', hi: 'Lorem Ipsum' },
            icon: '📝', 
            popular: false 
        },
        'base64-encoder': { 
            name: { en: 'Base64 Encoder', ru: 'Base64 кодер / декодер', es: 'Codificador Base64', de: 'Base64-Kodierer', pt: 'Codificador Base64', zh: 'Base64编码器', fr: 'Encodeur Base64', ja: 'Base64エンコーダ', ko: 'Base64 인코더', hi: 'Base64 एनकोडर' },
            icon: '🧬', 
            popular: true 
        },
        'json-beautifier': { 
            name: { en: 'JSON Beautifier', ru: 'JSON Beautifier', es: 'Formateador JSON', de: 'JSON-Formatierer', pt: 'Formatador JSON', zh: 'JSON美化器', fr: 'Formateur JSON', ja: 'JSON整形', ko: 'JSON 뷰티파이어', hi: 'JSON ब्यूटिफायर' },
            icon: '✨', 
            popular: true 
        },
        'text-case-converter': { 
            name: { en: 'Text Case Converter', ru: 'Конвертер регистра', es: 'Conversor de Texto', de: 'Textkonverter', pt: 'Conversor de Texto', zh: '文本大小写转换器', fr: 'Convertisseur de Casse', ja: 'テキスト変換', ko: '텍스트 변환기', hi: 'टेक्स्ट केस कनवर्टर' },
            icon: '🔠', 
            popular: false 
        },
        'text-diff-viewer': { 
            name: { en: 'Text Diff', ru: 'Просмотр различий', es: 'Diferencias', de: 'Text-Diff', pt: 'Diferenças', zh: '文本对比', fr: 'Différences', ja: 'テキスト比較', ko: '텍스트 비교', hi: 'टेक्स्ट अंतर' },
            icon: '📊', 
            popular: false 
        },
        'aead-file': { 
            name: { en: 'AEAD Encryption', ru: 'AEAD шифрование', es: 'Cifrado AEAD', de: 'AEAD-Verschlüsselung', pt: 'Criptografia AEAD', zh: 'AEAD加密', fr: 'Chiffrement AEAD', ja: 'AEAD暗号化', ko: 'AEAD 암호화', hi: 'AEAD एन्क्रिप्शन' },
            icon: '🛡️', 
            popular: false 
        },
        'openssh-keys': { 
            name: { en: 'OpenSSH Keys', ru: 'Ключи OpenSSH', es: 'Claves OpenSSH', de: 'OpenSSH-Schlüssel', pt: 'Chaves OpenSSH', zh: 'OpenSSH密钥', fr: 'Clés OpenSSH', ja: 'OpenSSH鍵', ko: 'OpenSSH 키', hi: 'OpenSSH कुंजी' },
            icon: '🔑', 
            popular: false 
        },
        'x509': { 
            name: { en: 'X.509 Certificates', ru: 'Сертификаты X.509', es: 'Certificados X.509', de: 'X.509-Zertifikate', pt: 'Certificados X.509', zh: 'X.509证书', fr: 'Certificats X.509', ja: 'X.509証明書', ko: 'X.509 인증서', hi: 'X.509 प्रमाण पत्र' },
            icon: '📜', 
            popular: false 
        },
        'url-encoder': { 
            name: { en: 'URL Encoder', ru: 'URL кодер', es: 'Codificador URL', de: 'URL-Kodierer', pt: 'Codificador URL', zh: 'URL编码器', fr: 'Encodeur URL', ja: 'URLエンコーダ', ko: 'URL 인코더', hi: 'URL एनकोडर' },
            icon: '🔗', 
            popular: false 
        },
        'xml-beautifier': { 
            name: { en: 'XML Beautifier', ru: 'XML Beautifier', es: 'Formateador XML', de: 'XML-Formatierer', pt: 'Formatador XML', zh: 'XML美化器', fr: 'Formateur XML', ja: 'XML整形', ko: 'XML 뷰티파이어', hi: 'XML ब्यूटिफायर' },
            icon: '🧷', 
            popular: false 
        },
        'hex-encoder': { 
            name: { en: 'Hex Encoder', ru: 'Hex кодер', es: 'Codificador Hex', de: 'Hex-Kodierer', pt: 'Codificador Hex', zh: 'Hex编码器', fr: 'Encodeur Hex', ja: 'Hexエンコーダ', ko: 'Hex 인코더', hi: 'Hex एनकोडर' },
            icon: '🧱', 
            popular: false 
        },
        'base32-encoder': { 
            name: { en: 'Base32 Encoder', ru: 'Base32 кодер', es: 'Codificador Base32', de: 'Base32-Kodierer', pt: 'Codificador Base32', zh: 'Base32编码器', fr: 'Encodeur Base32', ja: 'Base32エンコーダ', ko: 'Base32 인코더', hi: 'Base32 एनकोडर' },
            icon: '🧪', 
            popular: false 
        },
        'base58-encoder': { 
            name: { en: 'Base58 Encoder', ru: 'Base58 кодер', es: 'Codificador Base58', de: 'Base58-Kodierer', pt: 'Codificador Base58', zh: 'Base58编码器', fr: 'Encodeur Base58', ja: 'Base58エンコーダ', ko: 'Base58 인코더', hi: 'Base58 एनकोडर' },
            icon: '🧿', 
            popular: false 
        },
        'date-converter': { 
            name: { en: 'Date Converter', ru: 'Конвертер дат', es: 'Conversor de Fechas', de: 'Datums-Konverter', pt: 'Conversor de Datas', zh: '日期转换器', fr: 'Convertisseur de Dates', ja: '日付変換', ko: '날짜 변환기', hi: 'दिनांक कनवर्टर' },
            icon: '📅', 
            popular: false 
        },
        'jwt-decoder': { 
            name: { en: 'JWT Decoder', ru: 'Декодер JWT', es: 'Decodificador JWT', de: 'JWT-Dekodierer', pt: 'Decodificador JWT', zh: 'JWT解码器', fr: 'Décodeur JWT', ja: 'JWTデコーダ', ko: 'JWT 디코더', hi: 'JWT डिकोडर' },
            icon: '🔓', 
            popular: true 
        },
        'jwt-encoder': { 
            name: { en: 'JWT Encoder', ru: 'Кодировщик JWT', es: 'Codificador JWT', de: 'JWT-Kodierer', pt: 'Codificador JWT', zh: 'JWT编码器', fr: 'Encodeur JWT', ja: 'JWTエンコーダ', ko: 'JWT 인코더', hi: 'JWT एनकोडर' },
            icon: '🔐', 
            popular: false 
        },
        'regex-tester': { 
            name: { en: 'Regex Tester', ru: 'Тестер Regex', es: 'Probador Regex', de: 'Regex-Tester', pt: 'Testador Regex', zh: '正则表达式测试器', fr: 'Testeur Regex', ja: 'Regexテスター', ko: 'Regex 테스터', hi: 'Regex परीक्षक' },
            icon: '🔍', 
            popular: true 
        },
        'qr-code-generator': { 
            name: { en: 'QR Generator', ru: 'Генератор QR-кодов', es: 'Generador QR', de: 'QR-Generator', pt: 'Gerador QR', zh: '二维码生成器', fr: 'Générateur QR', ja: 'QRジェネレータ', ko: 'QR 생성기', hi: 'QR जनरेटर' },
            icon: '📱', 
            popular: true 
        },
        'hmac-calculator': { 
            name: { en: 'HMAC Calculator', ru: 'Калькулятор HMAC', es: 'Calculadora HMAC', de: 'HMAC-Rechner', pt: 'Calculadora HMAC', zh: 'HMAC计算器', fr: 'Calculateur HMAC', ja: 'HMAC計算', ko: 'HMAC 계산기', hi: 'HMAC कैलकुलेटर' },
            icon: '🔐', 
            popular: false 
        },
        'yaml-beautifier-validator': { 
            name: { en: 'YAML Tools', ru: 'YAML Форматировщик', es: 'Herramientas YAML', de: 'YAML-Tools', pt: 'Ferramentas YAML', zh: 'YAML工具', fr: 'Outils YAML', ja: 'YAMLツール', ko: 'YAML 도구', hi: 'YAML टूल्स' },
            icon: '📄', 
            popular: false 
        },
        'qr-scanner': { 
            name: { en: 'QR Scanner', ru: 'Сканер QR-кодов', es: 'Escáner QR', de: 'QR-Scanner', pt: 'Scanner QR', zh: '二维码扫描器', fr: 'Scanner QR', ja: 'QRスキャナー', ko: 'QR 스캐너', hi: 'QR स्कैनर' },
            icon: '📷', 
            popular: false 
        },
        'pdf-merger': { 
            name: { en: 'PDF Merger', ru: 'Объединение PDF', es: 'Combinar PDF', de: 'PDF-Zusammenführung', pt: 'Mesclador PDF', zh: 'PDF合并器', fr: 'Fusionneur PDF', ja: 'PDF結合', ko: 'PDF 병합', hi: 'PDF मर्जर' },
            icon: '📑', 
            popular: false 
        },
        'pdf-compressor': { 
            name: { en: 'PDF Compressor', ru: 'Сжатие PDF', es: 'Compresor PDF', de: 'PDF-Komprimierer', pt: 'Compressor PDF', zh: 'PDF压缩器', fr: 'Compresseur PDF', ja: 'PDF圧縮', ko: 'PDF 압축기', hi: 'PDF संपीड़क' },
            icon: '📉', 
            popular: false 
        },
        'html-entity-encoder': { 
            name: { en: 'HTML Entities', ru: 'HTML Entities', es: 'Entidades HTML', de: 'HTML-Entities', pt: 'Entidades HTML', zh: 'HTML实体', fr: 'Entités HTML', ja: 'HTMLエンティティ', ko: 'HTML 엔티티', hi: 'HTML एंटिटीज़' },
            icon: '</>', 
            popular: false 
        },
        'unit-converter': { 
            name: { en: 'Unit Converter', ru: 'Конвертер единиц', es: 'Conversor de Unidades', de: 'Einheiten-Konverter', pt: 'Conversor de Unidades', zh: '单位转换器', fr: 'Convertisseur d\'Unités', ja: '単位変換', ko: '단위 변환기', hi: 'यूनिट कनवर्टर' },
            icon: '📏', 
            popular: false 
        }
    };

    let currentLang = 'en';
    let currentTab = 'favorites';

    // ========================================
    // FAVORITES FUNCTIONS
    // ========================================

    function getFavorites() {
        try {
            const stored = localStorage.getItem(FAVORITES_KEY);
            return stored ? JSON.parse(stored) : [];
        } catch (e) {
            console.error('Error reading favorites from localStorage:', e);
            return [];
        }
    }

    function saveFavorites(favorites) {
        try {
            localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));
            window.dispatchEvent(new CustomEvent('favoritesChanged', { detail: { favorites } }));
            renderFavorites();
        } catch (e) {
            console.error('Error saving favorites to localStorage:', e);
        }
    }

    function isFavorite(slug) {
        return getFavorites().includes(slug);
    }

    function addFavorite(slug) {
        const favorites = getFavorites();
        if (!favorites.includes(slug)) {
            favorites.push(slug);
            saveFavorites(favorites);
        }
    }

    function removeFavorite(slug) {
        const favorites = getFavorites();
        const index = favorites.indexOf(slug);
        if (index > -1) {
            favorites.splice(index, 1);
            saveFavorites(favorites);
        }
    }

    function toggleFavorite(slug) {
        if (isFavorite(slug)) {
            removeFavorite(slug);
        } else {
            addFavorite(slug);
        }
        updateFavoriteButtons();
    }

    // ========================================
    // RECENT TOOLS FUNCTIONS
    // ========================================

    function getRecent() {
        try {
            const stored = localStorage.getItem(RECENT_KEY);
            return stored ? JSON.parse(stored) : [];
        } catch (e) {
            console.error('Error reading recent tools from localStorage:', e);
            return [];
        }
    }

    function saveRecent(recent) {
        try {
            localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
            window.dispatchEvent(new CustomEvent('recentChanged', { detail: { recent } }));
            renderRecent();
        } catch (e) {
            console.error('Error saving recent tools to localStorage:', e);
        }
    }

    function addRecent(slug, name, icon) {
        const recent = getRecent();
        
        // Remove if already exists
        const existingIndex = recent.findIndex(item => item.slug === slug);
        if (existingIndex > -1) {
            recent.splice(existingIndex, 1);
        }
        
        // Get tool info from registry or use provided values
        const toolInfo = TOOLS_REGISTRY[slug] || { name: name || slug, icon: icon || '🔧', popular: false };
        
        // Add to beginning - store only slug and icon, name will be resolved from registry on render
        recent.unshift({ 
            slug, 
            icon: toolInfo.icon, 
            timestamp: Date.now() 
        });
        
        // Keep only max items
        if (recent.length > MAX_RECENT_ITEMS) {
            recent.length = MAX_RECENT_ITEMS;
        }
        
        saveRecent(recent);
    }

    function clearRecent() {
        saveRecent([]);
    }

    function removeRecent(slug) {
        const recent = getRecent();
        const index = recent.findIndex(item => item.slug === slug);
        if (index > -1) {
            recent.splice(index, 1);
            saveRecent(recent);
        }
    }

    // ========================================
    // RENDERING FUNCTIONS
    // ========================================

    function getLang() {
        const section = document.getElementById('favorites-section');
        return section?.dataset.lang || currentLang;
    }

    function getLocalizedName(toolInfo, lang) {
        // If name is an object with translations
        if (toolInfo.name && typeof toolInfo.name === 'object') {
            // Try to get name in current language, fallback to English, then to slug
            return toolInfo.name[lang] || toolInfo.name['en'] || slug;
        }
        // If name is a string (backward compatibility or from stored recent)
        return toolInfo.name || slug;
    }

    function createToolCard(tool, slug) {
        const toolInfo = TOOLS_REGISTRY[slug] || { name: tool.name || slug, icon: tool.icon || '🔧', popular: false };
        const lang = getLang();
        const displayName = getLocalizedName(toolInfo, lang);
        
        return `
            <a href="/${lang}/${slug}" class="group p-4 rounded-xl border border-base-300 bg-base-100 hover:border-primary/50 hover:shadow-md transition-all">
                <div class="w-10 h-10 rounded-lg bg-gradient-to-br from-indigo-500/10 to-purple-500/10 flex items-center justify-center mb-3 group-hover:from-indigo-500/20 group-hover:to-purple-500/20 transition-colors">
                    <span class="text-xl">${toolInfo.icon}</span>
                </div>
                <div class="font-medium text-sm truncate">${displayName}</div>
                ${toolInfo.popular ? `
                    <div class="badge badge-sm badge-primary mt-2">
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="mr-1 inline">
                            <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/>
                        </svg>
                        Popular
                    </div>
                ` : ''}
            </a>
        `;
    }

    function renderFavorites() {
        const favorites = getFavorites();
        const grid = document.getElementById('favorites-grid');
        const emptyState = document.getElementById('favorites-empty');
        
        if (!grid || !emptyState) return;

        if (favorites.length === 0) {
            grid.classList.add('hidden');
            emptyState.classList.remove('hidden');
        } else {
            emptyState.classList.add('hidden');
            grid.classList.remove('hidden');
            
            grid.innerHTML = favorites.map(slug => {
                const toolInfo = TOOLS_REGISTRY[slug];
                if (!toolInfo) return '';
                return createToolCard(toolInfo, slug);
            }).join('');
        }
    }

    function renderRecent() {
        const recent = getRecent();
        const grid = document.getElementById('recent-grid');
        const emptyState = document.getElementById('recent-empty');
        const clearContainer = document.getElementById('recent-clear-container');
        
        if (!grid || !emptyState) return;

        if (recent.length === 0) {
            grid.classList.add('hidden');
            emptyState.classList.remove('hidden');
            if (clearContainer) clearContainer.classList.add('hidden');
        } else {
            emptyState.classList.add('hidden');
            grid.classList.remove('hidden');
            if (clearContainer) clearContainer.classList.remove('hidden');
            
            grid.innerHTML = recent.map(item => {
                return createToolCard(item, item.slug);
            }).join('');
        }
    }

    function switchTab(tab) {
        currentTab = tab;
        
        const favoritesBtn = document.getElementById('fav-tab-favorites');
        const recentBtn = document.getElementById('fav-tab-recent');
        const favoritesContent = document.getElementById('favorites-content');
        const recentContent = document.getElementById('recent-content');
        
        if (tab === 'favorites') {
            favoritesBtn?.classList.add('btn-primary');
            favoritesBtn?.classList.remove('btn-ghost');
            recentBtn?.classList.add('btn-ghost');
            recentBtn?.classList.remove('btn-primary');
            favoritesContent?.classList.remove('hidden');
            recentContent?.classList.add('hidden');
            renderFavorites();
        } else {
            recentBtn?.classList.add('btn-primary');
            recentBtn?.classList.remove('btn-ghost');
            favoritesBtn?.classList.add('btn-ghost');
            favoritesBtn?.classList.remove('btn-primary');
            recentContent?.classList.remove('hidden');
            favoritesContent?.classList.add('hidden');
            renderRecent();
        }
    }

    // ========================================
    // UI UPDATES
    // ========================================

    function updateFavoriteButtons() {
        const buttons = document.querySelectorAll('.favorite-btn');
        buttons.forEach(btn => {
            const slug = btn.dataset.toolSlug;
            if (slug) {
                const favorited = isFavorite(slug);
                btn.classList.toggle('is-favorite', favorited);
                btn.setAttribute('aria-pressed', favorited);
                
                // Update star fill
                const svg = btn.querySelector('svg');
                if (svg) {
                    if (favorited) {
                        svg.setAttribute('fill', 'currentColor');
                    } else {
                        svg.setAttribute('fill', 'none');
                    }
                }
            }
        });
    }

    // ========================================
    // EVENT HANDLERS
    // ========================================

    function setupEventHandlers() {
        // Tab buttons
        const favoritesBtn = document.getElementById('fav-tab-favorites');
        const recentBtn = document.getElementById('fav-tab-recent');
        
        favoritesBtn?.addEventListener('click', () => switchTab('favorites'));
        recentBtn?.addEventListener('click', () => switchTab('recent'));
        
        // Clear recent button
        const clearBtn = document.getElementById('clear-recent-btn');
        clearBtn?.addEventListener('click', (e) => {
            e.preventDefault();
            clearRecent();
        });
        
        // Favorite buttons (event delegation)
        if (!window.__favoritesHandlersBound) {
            window.__favoritesHandlersBound = true;
            
            document.addEventListener('click', (e) => {
                const btn = e.target.closest('.favorite-btn');
                if (btn) {
                    e.preventDefault();
                    e.stopPropagation();
                    const slug = btn.dataset.toolSlug;
                    if (slug) {
                        toggleFavorite(slug);
                    }
                }
            }, true);
        }
    }

    // ========================================
    // INITIALIZATION
    // ========================================

    function init() {
        const section = document.getElementById('favorites-section');
        if (!section || section.dataset.initialized) return;
        
        section.dataset.initialized = 'true';
        currentLang = section.dataset.lang || 'en';
        
        setupEventHandlers();
        updateFavoriteButtons();
        
        // Initial render based on current tab
        if (currentTab === 'favorites') {
            renderFavorites();
        } else {
            renderRecent();
        }
        
        // Listen for changes
        window.addEventListener('favoritesChanged', () => {
            updateFavoriteButtons();
            if (currentTab === 'favorites') {
                renderFavorites();
            }
        });
        
        window.addEventListener('recentChanged', () => {
            if (currentTab === 'recent') {
                renderRecent();
            }
        });
    }

    // Auto-init when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Re-init on navigation (for Blazor enhanced nav)
    const observer = new MutationObserver(() => {
        const section = document.getElementById('favorites-section');
        if (section && !section.dataset.initialized) {
            init();
        }
    });

    if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
    }

    // Expose API
    window.MyDevToolsFavorites = {
        getFavorites,
        addFavorite,
        removeFavorite,
        toggleFavorite,
        isFavorite
    };

    window.MyDevToolsRecent = {
        getRecent,
        addRecent,
        clearRecent,
        removeRecent
    };
})();

// ========================================
// AUTO-ADD CURRENT TOOL TO RECENT
// ========================================
// This runs on all pages and adds the current tool to recent when on a tool page

(function() {
    'use strict';
    
    function autoAddToRecent() {
        // Check if we're on a tool page (URL pattern: /{lang}/{tool-slug})
        const path = window.location.pathname;
        const match = path.match(/^\/(en|ru|es|de|pt|zh|fr|ja|ko|hi)\/([a-z0-9-]+)$/);
        
        if (!match) return;
        
        const lang = match[1];
        const slug = match[2];
        
        // Don't add home page or special pages
        if (['', 'index', 'home', 'privacy', 'terms'].includes(slug)) return;
        
        // Wait for MyDevToolsRecent to be available
        if (typeof window.MyDevToolsRecent === 'undefined') {
            setTimeout(autoAddToRecent, 100);
            return;
        }
        
        // Tool registry for getting names and icons
        const TOOLS_REGISTRY = {
            'image-converter': { name: 'Image Converter', icon: '🖼️' },
            'image-compressor': { name: 'Image Compressor', icon: '📉' },
            'image-resizer': { name: 'Image Resizer', icon: '📏' },
            'color-converter': { name: 'Color Converter', icon: '🎨' },
            'markdown-preview': { name: 'Markdown Preview', icon: '📄' },
            'hash-calculator': { name: 'Hash Calculator', icon: '🔐' },
            'password-generator': { name: 'Password Generator', icon: '🎲' },
            'uuid-generator': { name: 'UUID Generator', icon: '🆔' },
            'lorem-ipsum-generator': { name: 'Lorem Ipsum', icon: '📝' },
            'base64-encoder': { name: 'Base64 Encoder', icon: '🧬' },
            'json-beautifier': { name: 'JSON Beautifier', icon: '✨' },
            'text-case-converter': { name: 'Text Case Converter', icon: '🔠' },
            'text-diff-viewer': { name: 'Text Diff', icon: '📊' },
            'aead-file': { name: 'AEAD Encryption', icon: '🛡️' },
            'openssh-keys': { name: 'OpenSSH Keys', icon: '🔑' },
            'x509': { name: 'X.509 Certificates', icon: '📜' },
            'url-encoder': { name: 'URL Encoder', icon: '🔗' },
            'xml-beautifier': { name: 'XML Beautifier', icon: '🧷' },
            'hex-encoder': { name: 'Hex Encoder', icon: '🧱' },
            'base32-encoder': { name: 'Base32 Encoder', icon: '🧪' },
            'base58-encoder': { name: 'Base58 Encoder', icon: '🧿' },
            'date-converter': { name: 'Date Converter', icon: '📅' },
            'jwt-decoder': { name: 'JWT Decoder', icon: '🔓' },
            'jwt-encoder': { name: 'JWT Encoder', icon: '🔐' },
            'regex-tester': { name: 'Regex Tester', icon: '🔍' },
            'qr-code-generator': { name: 'QR Generator', icon: '📱' },
            'hmac-calculator': { name: 'HMAC Calculator', icon: '🔐' },
            'yaml-beautifier-validator': { name: 'YAML Tools', icon: '📄' },
            'qr-scanner': { name: 'QR Scanner', icon: '📷' },
            'pdf-merger': { name: 'PDF Merger', icon: '📑' },
            'pdf-compressor': { name: 'PDF Compressor', icon: '📉' },
            'html-entity-encoder': { name: 'HTML Entities', icon: '</>' },
            'unit-converter': { name: 'Unit Converter', icon: '📏' },
            'cron-parser': { name: 'Cron Parser', icon: '📅' }
        };
        
        const tool = TOOLS_REGISTRY[slug];
        if (tool) {
            window.MyDevToolsRecent.addRecent(slug, tool.name, tool.icon);
            console.log('[Recent] Added:', slug);
        }
    }
    
    // Run on page load
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', autoAddToRecent);
    } else {
        autoAddToRecent();
    }
    
    // Also run on navigation (for Blazor enhanced nav)
    let lastPath = window.location.pathname;
    let pathCheckTimer;
    const observer = new MutationObserver(() => {
        clearTimeout(pathCheckTimer);
        pathCheckTimer = setTimeout(() => {
            const currentPath = window.location.pathname;
            if (currentPath !== lastPath) {
                lastPath = currentPath;
                autoAddToRecent();
            }
        }, 300); // Debounce 300ms
    });
    
    if (document.body) {
        observer.observe(document.body, { childList: true, subtree: false }); // Only direct children, not subtree
    }
})();

// ========================================
// ADD RECENT/FAVORITE BADGES TO TOOL CARDS
// ========================================
(function() {
    'use strict';
    
    const POPULAR_SLUGS = ['json-beautifier', 'base64-encoder', 'password-generator'];
    
    function addBadgesToToolCards() {
        // Get recent and favorites from localStorage
        const favorites = (window.MyDevToolsFavorites?.getFavorites) ? window.MyDevToolsFavorites.getFavorites() : [];
        const recentItems = (window.MyDevToolsRecent?.getRecent) ? window.MyDevToolsRecent.getRecent() : [];
        const recentSlugs = recentItems.map(r => r.slug);
        
        // Get localized strings from data attributes
        const toolsSection = document.getElementById('tools');
        const recentTitle = toolsSection?.dataset.badgeRecent || 'Recent';
        
        // Find all tool cards
        const toolCards = document.querySelectorAll('.tool-card[data-tool-slug]');
        
        toolCards.forEach(card => {
            const slug = card.dataset.toolSlug;
            if (!slug) return;
            
            const cardBody = card.querySelector('.card-body');
            if (!cardBody) return;
            
            // Remove existing recent/favorite badges (not popular, as it's rendered server-side)
            const existingBadges = cardBody.querySelectorAll('.tool-status-badge');
            existingBadges.forEach(b => b.remove());
            
            // Determine which badge to show (priority: recent, popular is already rendered)
            // Note: favorite badge is not shown here as it has its own button on the right side
            let badgeHtml = '';
            
            if (recentSlugs.includes(slug) && !POPULAR_SLUGS.includes(slug)) {
                // Show recent badge only if not popular (popular badge is shown server-side)
                badgeHtml = `<span class="tool-status-badge absolute top-2 left-2 text-lg" title="${recentTitle}">🕐</span>`;
            }
            
            if (badgeHtml) {
                cardBody.insertAdjacentHTML('afterbegin', badgeHtml);
            }
        });
    }
    
    // Run on page load
    function init() {
        if (typeof window.MyDevToolsFavorites === 'undefined' || typeof window.MyDevToolsRecent === 'undefined') {
            setTimeout(init, 100);
            return;
        }
        
        addBadgesToToolCards();
    }
    
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        setTimeout(init, 100);
    }
    
    // Update badges when favorites/recent change
    window.addEventListener('favoritesChanged', addBadgesToToolCards);
    window.addEventListener('recentChanged', addBadgesToToolCards);
    
    // Re-run when navigating (for Blazor enhanced navigation)
    let badgeUpdateTimer;
    let lastToolsHtml = '';
    const badgeObserver = new MutationObserver(() => {
        clearTimeout(badgeUpdateTimer);
        badgeUpdateTimer = setTimeout(() => {
            const toolsSection = document.getElementById('tools');
            if (toolsSection) {
                const currentHtml = toolsSection.innerHTML;
                // Only update if tools section actually changed (not just our badge insertion)
                if (currentHtml !== lastToolsHtml && !currentHtml.includes('tool-status-badge')) {
                    lastToolsHtml = currentHtml;
                    addBadgesToToolCards();
                }
            }
        }, 300); // Debounce 300ms
    });
    
    if (document.body) {
        badgeObserver.observe(document.body, { childList: true, subtree: false }); // Only direct children, not subtree
    }
})();
