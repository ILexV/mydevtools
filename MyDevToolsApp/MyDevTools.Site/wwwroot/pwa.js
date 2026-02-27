// PWA Management Script
(function () {
    'use strict';

    let deferredPrompt = null;
    let swRegistration = null;

    // Register Service Worker
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker
                .register('/sw.js')
                .then((registration) => {
                    swRegistration = registration;

                    // Check for updates every 60 seconds
                    setInterval(() => {
                        registration.update();
                    }, 60000);

                    // Listen for updates
                    registration.addEventListener('updatefound', () => {
                        const newWorker = registration.installing;
                        console.log('[PWA] New service worker found');

                        newWorker.addEventListener('statechange', () => {
                            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                                console.log('[PWA] New version available');
                                showUpdateNotification();
                            }
                        });
                    });
                })
                .catch((error) => {
                    console.error('[PWA] Service Worker registration failed:', error);
                });

            // Handle controller change (new SW activated)
            navigator.serviceWorker.addEventListener('controllerchange', () => {
                console.log('[PWA] Controller changed');
                // Don't reload automatically, it disrupts user experience
                // window.location.reload(); 
            });
        });
    }

    // Capture install prompt
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredPrompt = e;
        // Don't show prompt automatically - user must click the button
        console.log('[PWA] Install prompt captured, waiting for user action');
    });

    // Handle app installed
    window.addEventListener('appinstalled', () => {
        deferredPrompt = null;
        hideInstallPrompt();

        // Show success message
        const message = document.querySelector('[data-pwa-installed-message]');
        if (message) {
            message.textContent = message.getAttribute('data-pwa-installed-message');
            setTimeout(() => {
                message.textContent = '';
            }, 5000);
        }
    });

    // Show install prompt
    function showInstallPrompt() {
        const prompt = document.getElementById('pwa-install-prompt');
        if (!prompt) return;

        // Check if already installed
        if (window.matchMedia('(display-mode: standalone)').matches) {
            console.log('[PWA] App already installed');
            return;
        }

        // Check if dismissed
        const dismissed = localStorage.getItem('pwa-install-dismissed');
        if (dismissed === 'true') {
            return;
        }

        // Only show prompt if browser supports it
        if (!deferredPrompt) {
            return;
        }

        prompt.style.display = 'block';

        // Handle install button click
        const installBtn = document.getElementById('pwa-install-btn');
        if (installBtn) {
            // Remove existing listener to avoid duplicates
            installBtn.removeEventListener('click', handleInstallClick);
            installBtn.addEventListener('click', handleInstallClick);
        }

        // Handle dismiss button
        const dismissBtn = document.getElementById('pwa-install-dismiss');
        if (dismissBtn) {
            // Remove existing listener to avoid duplicates
            dismissBtn.removeEventListener('click', handleDismissClick);
            dismissBtn.addEventListener('click', handleDismissClick);
        }
    }

    async function handleInstallClick() {
        if (!deferredPrompt) {
            console.log('[PWA] Install prompt not available');
            return;
        }

        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        console.log('[PWA] User choice:', outcome);

        if (outcome === 'dismissed') {
            localStorage.setItem('pwa-install-dismissed', 'true');
        }

        deferredPrompt = null;
        hideInstallPrompt();
    }

    function handleDismissClick() {
        localStorage.setItem('pwa-install-dismissed', 'true');
        hideInstallPrompt();
    }

    // Hide install prompt
    function hideInstallPrompt() {
        const prompt = document.getElementById('pwa-install-prompt');
        if (prompt) {
            prompt.style.display = 'none';
        }
    }

    // Show update notification
    function showUpdateNotification() {
        const notification = document.getElementById('pwa-update-notification');
        if (!notification) {
            console.warn('[PWA] Update notification element not found');
            return;
        }

        notification.style.display = 'block';

        // Handle update button click
        const updateBtn = document.getElementById('pwa-update-btn');
        if (updateBtn) {
            updateBtn.addEventListener('click', () => {
                if (swRegistration && swRegistration.waiting) {
                    // Tell the waiting service worker to skip waiting
                    swRegistration.waiting.postMessage({ type: 'SKIP_WAITING' });
                } else {
                    // Force reload
                    window.location.reload();
                }
            });
        }

        // Handle dismiss button
        const dismissBtn = document.getElementById('pwa-update-dismiss');
        if (dismissBtn) {
            dismissBtn.addEventListener('click', () => {
                notification.style.display = 'none';
            });
        }
    }

    // Expose PWA utilities globally
    window.PWA = {
        showInstallPrompt,
        hideInstallPrompt,
        showUpdateNotification,
        clearCache: () => {
            if (swRegistration && swRegistration.active) {
                swRegistration.active.postMessage({ type: 'CLEAR_CACHE' });
                console.log('[PWA] Cache clear requested');
            }
        },
        isInstalled: () => {
            return window.matchMedia('(display-mode: standalone)').matches ||
                window.navigator.standalone === true;
        }
    };
})();
