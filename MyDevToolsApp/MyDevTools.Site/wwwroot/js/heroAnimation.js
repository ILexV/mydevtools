/**
 * Hero Canvas Animation - Particle System with Connections
 * Features:
 * - 30 particles with random movement
 * - Connections when distance < 100px
 * - Page Visibility API - pauses when tab is hidden
 * - Touch device detection - disabled on mobile
 * - ResizeObserver for responsive canvas
 */

(function() {
    'use strict';

    let canvas = null;
    let ctx = null;
    let animationId = null;
    let particles = [];
    let resizeObserver = null;
    let isPaused = false;
    let isTouchDevice = false;

    // Configuration
    const CONFIG = {
        particleCount: 30,
        connectionDistance: 100,
        particleSpeed: 0.5,
        particleRadius: { min: 2, max: 4 },
        particleOpacity: { min: 0.4, max: 0.9 },
        colors: {
            particle: '99, 102, 241', // Indigo
            connection: '99, 102, 241'
        }
    };

    /**
     * Check if device is touch-based (mobile/tablet)
     */
    function detectTouchDevice() {
        isTouchDevice = window.matchMedia('(pointer: coarse)').matches ||
                       'ontouchstart' in window ||
                       navigator.maxTouchPoints > 0;
    }

    /**
     * Initialize particle system
     */
    function initParticles() {
        particles = [];
        const width = canvas.offsetWidth;
        const height = canvas.offsetHeight;

        for (let i = 0; i < CONFIG.particleCount; i++) {
            particles.push({
                x: Math.random() * width,
                y: Math.random() * height,
                vx: (Math.random() - 0.5) * CONFIG.particleSpeed * 2,
                vy: (Math.random() - 0.5) * CONFIG.particleSpeed * 2,
                radius: Math.random() * (CONFIG.particleRadius.max - CONFIG.particleRadius.min) + CONFIG.particleRadius.min,
                opacity: Math.random() * (CONFIG.particleOpacity.max - CONFIG.particleOpacity.min) + CONFIG.particleOpacity.min
            });
        }
    }

    /**
     * Resize canvas to match display size
     */
    function resizeCanvas() {
        if (!canvas) return;
        
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        
        if (ctx) {
            ctx.scale(dpr, dpr);
        }
    }

    /**
     * Draw a single frame
     */
    function draw() {
        if (!ctx || !canvas || isPaused) return;

        const width = canvas.offsetWidth;
        const height = canvas.offsetHeight;

        ctx.clearRect(0, 0, width, height);

        // Update and draw particles
        particles.forEach((p, i) => {
            // Update position
            p.x += p.vx;
            p.y += p.vy;

            // Bounce off edges
            if (p.x < 0 || p.x > width) p.vx *= -1;
            if (p.y < 0 || p.y > height) p.vy *= -1;

            // Keep in bounds
            p.x = Math.max(0, Math.min(width, p.x));
            p.y = Math.max(0, Math.min(height, p.y));

            // Draw particle
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(${CONFIG.colors.particle}, ${p.opacity})`;
            ctx.fill();

            // Draw connections
            particles.slice(i + 1).forEach(p2 => {
                const dx = p.x - p2.x;
                const dy = p.y - p2.y;
                const dist = Math.sqrt(dx * dx + dy * dy);

                if (dist < CONFIG.connectionDistance) {
                    const opacity = 0.1 * (1 - dist / CONFIG.connectionDistance);
                    ctx.beginPath();
                    ctx.moveTo(p.x, p.y);
                    ctx.lineTo(p2.x, p2.y);
                    ctx.strokeStyle = `rgba(${CONFIG.colors.connection}, ${opacity})`;
                    ctx.stroke();
                }
            });
        });

        animationId = requestAnimationFrame(draw);
    }

    /**
     * Handle visibility change
     */
    function handleVisibilityChange() {
        if (document.hidden) {
            isPaused = true;
            if (animationId) {
                cancelAnimationFrame(animationId);
                animationId = null;
            }
        } else {
            isPaused = false;
            if (!animationId) {
                draw();
            }
        }
    }

    /**
     * Initialize the animation
     */
    function init() {
        // Don't run on touch devices
        detectTouchDevice();
        if (isTouchDevice) {
            console.log('[HeroAnimation] Touch device detected, skipping canvas animation');
            return;
        }

        canvas = document.getElementById('hero-particle-canvas');
        if (!canvas) {
            console.warn('[HeroAnimation] Canvas element not found');
            return;
        }

        ctx = canvas.getContext('2d');
        if (!ctx) {
            console.warn('[HeroAnimation] Could not get 2D context');
            return;
        }

        // Initial setup
        resizeCanvas();
        initParticles();

        // Setup resize observer
        resizeObserver = new ResizeObserver(() => {
            resizeCanvas();
            initParticles();
        });
        resizeObserver.observe(canvas);

        // Setup visibility handler
        document.addEventListener('visibilitychange', handleVisibilityChange);

        // Start animation
        draw();

        console.log('[HeroAnimation] Initialized successfully');
    }

    /**
     * Cleanup and destroy
     */
    function destroy() {
        if (animationId) {
            cancelAnimationFrame(animationId);
            animationId = null;
        }

        if (resizeObserver) {
            resizeObserver.disconnect();
            resizeObserver = null;
        }

        document.removeEventListener('visibilitychange', handleVisibilityChange);

        canvas = null;
        ctx = null;
        particles = [];

        console.log('[HeroAnimation] Destroyed');
    }

    // Expose to global scope for Blazor interop
    window.HeroAnimation = {
        init: init,
        destroy: destroy
    };

    // Auto-init if canvas exists (for non-Blazor pages)
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
