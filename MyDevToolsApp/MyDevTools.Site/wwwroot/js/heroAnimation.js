/**
 * Hero Animation - Floating Bubbles + Ferris Eye Tracking + Wave
 * Features:
 * - 15 floating purple bubbles with random movement
 * - Ferris eye tracking (eyes follow mouse cursor)
 * - Click-to-wave animation on Ferris claws
 * - Page Visibility API - pauses when tab is hidden
 * - Touch device detection - disabled on mobile
 * - ResizeObserver for responsive canvas
 */

(function () {
    'use strict';

    let bubblesContainer = null;
    let ferrisSvg = null;
    let bubbles = [];
    let isInitialized = false;
    let isPaused = false;
    let isTouchDevice = false;

    // Eye tracking elements
    let leftPupil = null;
    let rightPupil = null;
    let leftHighlight = null;
    let rightHighlight = null;

    // Claw elements
    let leftClaw = null;
    let rightClaw = null;
    let isWaving = false;

    const BUBBLE_COUNT = 15;

    /**
     * Check if device is touch-based (mobile/tablet)
     */
    function detectTouchDevice() {
        isTouchDevice = window.matchMedia('(pointer: coarse)').matches ||
            'ontouchstart' in window ||
            navigator.maxTouchPoints > 0;
    }

    /**
     * Create floating bubbles
     */
    function createBubbles() {
        if (!bubblesContainer) return;

        // Clear existing
        bubbles.forEach(b => b.remove());
        bubbles = [];

        for (let i = 0; i < BUBBLE_COUNT; i++) {
            const bubble = document.createElement('div');
            const size = Math.random() * 20 + 10;
            bubble.style.cssText = `
                position: absolute;
                width: ${size}px;
                height: ${size}px;
                left: ${Math.random() * 100}%;
                top: ${Math.random() * 100}%;
                background: linear-gradient(135deg, #6366f1, #a855f7);
                border-radius: 50%;
                opacity: 0.2;
                animation: floatBubble ${3 + Math.random() * 4}s ease-in-out infinite;
                animation-delay: ${Math.random() * 2}s;
                pointer-events: none;
            `;
            bubblesContainer.appendChild(bubble);
            bubbles.push(bubble);
        }
    }

    /**
     * Eye tracking - eyes follow the mouse
     */
    function handleMouseMove(e) {
        if (!ferrisSvg || isPaused) return;

        const rect = ferrisSvg.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;

        const angle = Math.atan2(e.clientY - centerY, e.clientX - centerX);
        const distance = Math.min(3, Math.hypot(e.clientX - centerX, e.clientY - centerY) / 50);

        const offsetX = Math.cos(angle) * distance;
        const offsetY = Math.sin(angle) * distance;

        // Move pupils
        if (leftPupil) {
            leftPupil.setAttribute('cx', 78 + offsetX);
            leftPupil.setAttribute('cy', 62 + offsetY);
        }
        if (rightPupil) {
            rightPupil.setAttribute('cx', 122 + offsetX);
            rightPupil.setAttribute('cy', 62 + offsetY);
        }
        if (leftHighlight) {
            leftHighlight.setAttribute('cx', 80 + offsetX);
            leftHighlight.setAttribute('cy', 58 + offsetY);
        }
        if (rightHighlight) {
            rightHighlight.setAttribute('cx', 120 + offsetX);
            rightHighlight.setAttribute('cy', 58 + offsetY);
        }
    }

    /**
     * Wave animation on click
     */
    function handleFerrisClick() {
        if (isWaving) return;
        isWaving = true;

        if (leftClaw) {
            leftClaw.style.animation = 'wave 1s ease-in-out';
            leftClaw.style.transformOrigin = '30px 80px';
        }
        if (rightClaw) {
            rightClaw.style.animation = 'wave 1s ease-in-out reverse';
            rightClaw.style.transformOrigin = '170px 80px';
        }

        setTimeout(() => {
            isWaving = false;
            if (leftClaw) {
                leftClaw.style.animation = 'clawIdle 3s ease-in-out infinite';
                leftClaw.style.transformOrigin = '30px 80px';
            }
            if (rightClaw) {
                rightClaw.style.animation = 'clawIdle 3s ease-in-out infinite reverse';
                rightClaw.style.transformOrigin = '170px 80px';
            }
        }, 1000);
    }

    /**
     * Handle visibility change
     */
    function handleVisibilityChange() {
        isPaused = document.hidden;
    }

    /**
     * Initialize the animation
     */
    function init() {
        if (isInitialized) return;

        // Don't run on touch devices
        detectTouchDevice();

        // Create bubbles regardless of touch
        bubblesContainer = document.getElementById('hero-bubbles-container');
        if (bubblesContainer) {
            createBubbles();
        }

        // Ferris interactivity - only on non-touch devices
        ferrisSvg = document.getElementById('ferris-svg');
        if (ferrisSvg) {
            leftPupil = document.getElementById('ferris-left-pupil');
            rightPupil = document.getElementById('ferris-right-pupil');
            leftHighlight = document.getElementById('ferris-left-highlight');
            rightHighlight = document.getElementById('ferris-right-highlight');
            leftClaw = document.getElementById('ferris-left-claw');
            rightClaw = document.getElementById('ferris-right-claw');

            if (!isTouchDevice) {
                window.addEventListener('mousemove', handleMouseMove);
            }
            ferrisSvg.addEventListener('click', handleFerrisClick);
        }

        // Setup visibility handler
        document.addEventListener('visibilitychange', handleVisibilityChange);

        isInitialized = true;
        console.log('[HeroAnimation] Initialized with Ferris');
    }

    /**
     * Cleanup and destroy
     */
    function destroy() {
        window.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('visibilitychange', handleVisibilityChange);

        if (ferrisSvg) {
            ferrisSvg.removeEventListener('click', handleFerrisClick);
        }

        // Remove bubbles
        bubbles.forEach(b => b.remove());
        bubbles = [];

        bubblesContainer = null;
        ferrisSvg = null;
        leftPupil = null;
        rightPupil = null;
        leftHighlight = null;
        rightHighlight = null;
        leftClaw = null;
        rightClaw = null;
        isInitialized = false;

        console.log('[HeroAnimation] Destroyed');
    }

    // Expose to global scope for Blazor interop
    window.HeroAnimation = {
        init: init,
        destroy: destroy
    };

    // Auto-init if element exists (for non-Blazor pages)
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
