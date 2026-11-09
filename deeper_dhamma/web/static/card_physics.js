/**
 * Deeper Dhamma — Generic Card Physics & Reordering Engine
 * 
 * High-performance, physics-based card reordering engine with:
 * 1. Step Exchange Animations: Simultaneous physical glide past adjacent neighbor cards
 *    (for ▲ / ▼ arrow button clicks).
 * 2. Pointer-Based Fluid Drag & Drop: Full pointer event support across desktop mouse,
 *    trackpad, and mobile touch screens with touch hold-to-grab (240ms).
 * 3. In-Place Ghosting: The dragged card leaves a static placeholder holding its exact
 *    physical slot in the layout.
 * 4. Solid Floating Clone: Cloned card at 100% opacity with 3D elevation shadow, gold
 *    accent border, and tactile tilt smoothly following the cursor/finger.
 * 5. Placement Indicator Line: A glowing gradient beam positioned in the inter-card gap
 *    without moving or disturbing surrounding cards during drag.
 * 6. Multi-Card FLIP Drop Animation: On release, surrounding cards smoothly slide to close
 *    the ghost gap and open space for the new card, which glides into position from its
 *    exact release coordinates with cubic-bezier easing.
 */

(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CardPhysics = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_OPTIONS = {
    container: null,
    itemSelector: '.reorderable-card',
    handleSelector: '.card-drag-handle',
    idAttribute: 'data-id',
    touchHoldDelay: 240,       // ms to hold finger before drag activates
    exchangeDuration: 280,     // ms for neighbor step exchange glide
    dropDuration: 320,         // ms for multi-card FLIP drop glide
    haptic: true,              // enable navigator.vibrate if available
    classes: {
      ghost: 'card-is-ghost',
      floating: 'card-floating-drag',
      indicator: 'card-drop-indicator',
      activeExchange: 'card-is-exchanging-active',
      targetExchange: 'card-is-exchanging-target',
      landed: 'card-just-exchanged',
    },
    onExchange: null,          // function(fromIdx, toIdx, fromId, toId, direction)
    onReorder: null,           // function(fromIdx, toIdx, fromId, targetId, placeBefore)
    onRender: null,            // function() -> caller re-renders DOM
  };

  class CardPhysics {
    constructor(options = {}) {
      this.options = { ...DEFAULT_OPTIONS, ...options };
      if (options.classes) {
        this.options.classes = { ...DEFAULT_OPTIONS.classes, ...options.classes };
      }

      this.container = typeof this.options.container === 'string'
        ? document.querySelector(this.options.container)
        : this.options.container;

      this.indicator = null;
      this.isExchanging = false;
      this.dragSession = null;
      this._boundCards = new Set();

      if (this.container) {
        this.attach(this.container);
      }
    }

    /**
     * Attach or re-attach the physics engine to a container element.
     */
    attach(container, options = null) {
      if (!container) return;
      this.container = container;
      this.container.style.position = 'relative';

      if (options && typeof options === 'object') {
        Object.assign(this.options, options);
      }

      // Clear bound cards cache so freshly rendered DOM nodes are bound
      this._boundCards.clear();

      // Ensure drop indicator exists in container
      const indClass = this.options.classes.indicator;
      this.indicator = this.container.querySelector(`.${indClass}`);
      if (!this.indicator) {
        this.indicator = document.createElement('div');
        this.indicator.className = indClass;
        this.container.appendChild(this.indicator);
      }
      this.indicator.style.display = 'none';

      // Attach pointer drag listeners to all current card items
      const cards = this.getCards();
      cards.forEach(card => this._initCard(card));
    }

    /**
     * Returns an array of current card DOM elements in layout order.
     */
    getCards() {
      if (!this.container) return [];
      return Array.from(this.container.querySelectorAll(this.options.itemSelector));
    }

    /**
     * Programmatically perform a physical step exchange between a card and its
     * immediate neighbor (e.g. for ▲ / ▼ reorder buttons).
     */
    stepExchange(currentCard, direction) {
      if (this.isExchanging || !currentCard || !this.container) return false;
      const cards = this.getCards();
      const currIdx = cards.indexOf(currentCard);
      if (currIdx === -1) return false;

      // Identify target card reliably from current layout sequence
      const targetIdx = direction === 'up' ? currIdx - 1 : currIdx + 1;
      if (targetIdx < 0 || targetIdx >= cards.length) {
        return false;
      }
      const targetCard = cards[targetIdx];
      if (!targetCard || !targetCard.matches(this.options.itemSelector)) {
        return false;
      }

      this.isExchanging = true;
      this.container.style.pointerEvents = 'none';

      const currentRect = currentCard.getBoundingClientRect();
      const targetRect = targetCard.getBoundingClientRect();
      const deltaY = targetRect.top - currentRect.top;

      const currId = currentCard.getAttribute(this.options.idAttribute);
      const targetId = targetCard.getAttribute(this.options.idAttribute);

      const { activeExchange, targetExchange, landed } = this.options.classes;
      const dur = this.options.exchangeDuration || 280;
      const easing = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

      // 1. Mark exchange classes for z-index and elevation
      currentCard.classList.add(activeExchange);
      targetCard.classList.add(targetExchange);

      // 2. Explicitly bind hardware-accelerated glide transition
      currentCard.style.transition = `transform ${dur}ms ${easing}, box-shadow ${dur}ms ease`;
      targetCard.style.transition = `transform ${dur}ms ${easing}, box-shadow ${dur}ms ease`;

      // 3. Force layout reflow so browser commits transition before starting transform
      void currentCard.offsetHeight;
      void targetCard.offsetHeight;

      // 4. Trigger physical exchange translation
      currentCard.style.transform = `translateY(${deltaY}px) scale(1.015)`;
      targetCard.style.transform = `translateY(${-deltaY}px) scale(0.995)`;

      setTimeout(() => {
        currentCard.style.transition = '';
        targetCard.style.transition = '';
        currentCard.style.transform = '';
        targetCard.style.transform = '';
        currentCard.classList.remove(activeExchange);
        targetCard.classList.remove(targetExchange);
        this.container.style.pointerEvents = '';

        if (typeof this.options.onExchange === 'function') {
          this.options.onExchange(currIdx, targetIdx, currId, targetId, direction);
        }

        if (typeof this.options.onRender === 'function') {
          this.options.onRender();
        }

        const selector = `[${this.options.idAttribute}="${CSS && CSS.escape ? CSS.escape(currId) : currId}"]`;
        const movedEl = this.container.querySelector(selector);
        if (movedEl) {
          movedEl.classList.add(landed);
          setTimeout(() => movedEl.classList.remove(landed), 600);
        }

        this.isExchanging = false;
      }, dur);

      return true;
    }

    /**
     * Private: Initialize pointer drag interactions on a single card element.
     */
    _initCard(card) {
      if (this._boundCards.has(card)) return;
      this._boundCards.add(card);

      // Prevent conflicting browser native HTML5 drag
      card.addEventListener('dragstart', (e) => e.preventDefault());

      let pressTimer = null;
      let startX = 0;
      let startY = 0;
      let isTracking = false;
      let hasStartedDrag = false;

      const onPointerDown = (e) => {
        if (this.isExchanging || this.dragSession) return;
        // Primary button only
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        // Ignore interactive elements
        if (e.target.closest('button, a, input, select, textarea, [data-no-drag], .download-dropdown-menu, .download-dropdown-wrapper')) {
          return;
        }

        isTracking = true;
        hasStartedDrag = false;
        startX = e.clientX;
        startY = e.clientY;

        const isHandle = Boolean(this.options.handleSelector && e.target.closest(this.options.handleSelector));

        if (e.pointerType === 'touch') {
          if (isHandle) {
            startDrag(e);
          } else {
            // Touch long-press hold delay
            pressTimer = setTimeout(() => {
              if (isTracking && !hasStartedDrag) {
                if (this.options.haptic && navigator.vibrate) {
                  try { navigator.vibrate(30); } catch (_) {}
                }
                startDrag(e);
              }
            }, this.options.touchHoldDelay);
          }
        }

        window.addEventListener('pointermove', onPointerMove, { passive: false });
        window.addEventListener('pointerup', onPointerUp);
        window.addEventListener('pointercancel', onPointerCancel);
      };

      const startDrag = (e) => {
        if (hasStartedDrag || this.dragSession || this.isExchanging) return;
        hasStartedDrag = true;

        const cards = this.getCards();
        const origIdx = cards.indexOf(card);
        if (origIdx === -1) return;

        const cardRect = card.getBoundingClientRect();
        const grabOffsetX = startX - cardRect.left;
        const grabOffsetY = startY - cardRect.top;
        const id = card.getAttribute(this.options.idAttribute);

        // 1. Create solid floating drag clone
        const floatingEl = card.cloneNode(true);
        const { ghost, floating, activeExchange, targetExchange, landed } = this.options.classes;

        floatingEl.classList.remove(ghost, landed, activeExchange, targetExchange);
        floatingEl.classList.add(floating);
        floatingEl.style.width = `${cardRect.width}px`;
        floatingEl.style.left = `${cardRect.left}px`;
        floatingEl.style.top = `${cardRect.top}px`;
        document.body.appendChild(floatingEl);

        // 2. Mark source card as ghost in place
        card.classList.add(ghost);

        // 3. Initialize drag session
        this.dragSession = {
          card,
          id,
          origIdx,
          floatingEl,
          grabOffsetX,
          grabOffsetY,
          targetSlot: origIdx,
          cards,
        };

        this._updateIndicator(e.clientY);
      };

      const onPointerMove = (e) => {
        if (!isTracking) return;

        if (!hasStartedDrag) {
          const dist = Math.hypot(e.clientX - startX, e.clientY - startY);
          const isHandle = Boolean(this.options.handleSelector && e.target.closest(this.options.handleSelector));
          const threshold = isHandle ? 3 : 6;

          if (dist > threshold) {
            if (e.pointerType === 'touch' && !isHandle) {
              // Scrolling gesture: cancel long hold
              clearTimeout(pressTimer);
              pressTimer = null;
              cleanupTracking();
              return;
            }
            startDrag(e);
          }
        }

        if (hasStartedDrag && this.dragSession) {
          e.preventDefault();
          const x = e.clientX - this.dragSession.grabOffsetX;
          const y = e.clientY - this.dragSession.grabOffsetY;
          this.dragSession.floatingEl.style.left = `${x}px`;
          this.dragSession.floatingEl.style.top = `${y}px`;

          this._updateIndicator(e.clientY);
        }
      };

      const onPointerUp = () => {
        clearTimeout(pressTimer);
        pressTimer = null;
        if (hasStartedDrag && this.dragSession) {
          this._finishDrag();
        } else {
          cleanupTracking();
        }
      };

      const onPointerCancel = () => {
        clearTimeout(pressTimer);
        pressTimer = null;
        if (hasStartedDrag && this.dragSession) {
          this._finishDrag();
        } else {
          cleanupTracking();
        }
      };

      const cleanupTracking = () => {
        isTracking = false;
        hasStartedDrag = false;
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerCancel);
      };

      card.addEventListener('pointerdown', onPointerDown);
    }

    /**
     * Private: Update placement indicator position based on pointer Y coordinates.
     */
    _updateIndicator(clientY) {
      if (!this.dragSession || !this.indicator) return;
      const cards = this.dragSession.cards;
      let slot = cards.length;

      for (let i = 0; i < cards.length; i++) {
        const rect = cards[i].getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        if (clientY < midY) {
          slot = i;
          break;
        }
      }

      this.dragSession.targetSlot = slot;

      const containerRect = this.container.getBoundingClientRect();
      let topPos = 0;

      if (cards.length === 0) {
        topPos = 0;
      } else if (slot === 0) {
        const firstRect = cards[0].getBoundingClientRect();
        topPos = (firstRect.top - containerRect.top) - 6;
      } else if (slot >= cards.length) {
        const lastRect = cards[cards.length - 1].getBoundingClientRect();
        topPos = (lastRect.bottom - containerRect.top) + 6;
      } else {
        const prevRect = cards[slot - 1].getBoundingClientRect();
        const nextRect = cards[slot].getBoundingClientRect();
        const midY = (prevRect.bottom + nextRect.top) / 2;
        topPos = midY - containerRect.top;
      }

      this.indicator.style.top = `${topPos}px`;
      this.indicator.style.display = 'block';
    }

    /**
     * Private: Resolve pointer release with multi-card FLIP drop animation.
     */
    _finishDrag() {
      if (!this.dragSession) return;

      const { card, id, origIdx, floatingEl, targetSlot, cards } = this.dragSession;
      this.dragSession = null;
      if (this.indicator) {
        this.indicator.style.display = 'none';
      }

      let newIdx = targetSlot;
      if (targetSlot > origIdx) {
        newIdx = targetSlot - 1;
      }
      newIdx = Math.max(0, Math.min(newIdx, cards.length - 1));

      const { ghost, landed } = this.options.classes;
      const durationMs = this.options.dropDuration || 280;
      const easing = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

      this.isExchanging = true;
      this.container.style.pointerEvents = 'none';

      // Capture floating card's current viewport coordinates at release
      const floatingRect = floatingEl.getBoundingClientRect();

      // Case A: Released in original slot (no index change)
      if (newIdx === origIdx) {
        const destRect = card.getBoundingClientRect();
        const deltaX = destRect.left - floatingRect.left;
        const deltaY = destRect.top - floatingRect.top;

        floatingEl.style.transition = `transform ${durationMs}ms ${easing}, box-shadow ${durationMs}ms ease, border-color ${durationMs}ms ease`;
        void floatingEl.offsetHeight;

        floatingEl.style.transform = `translate(${deltaX}px, ${deltaY}px) scale(1) rotate(0deg)`;
        floatingEl.style.boxShadow = 'var(--shadow-card)';
        floatingEl.style.borderColor = 'var(--border-subtle)';

        setTimeout(() => {
          if (floatingEl.parentNode) floatingEl.remove();
          card.classList.remove(ghost);
          card.classList.add(landed);
          setTimeout(() => card.classList.remove(landed), 600);
          this.container.style.pointerEvents = '';
          this.isExchanging = false;
        }, durationMs);
        return;
      }

      // Case B: Reordered to new slot — execute physical drop and multi-card FLIP glide
      // 1. Snapshot initial positions of all cards before DOM move
      const firstRects = new Map();
      cards.forEach(c => {
        const cId = c.getAttribute(this.options.idAttribute);
        if (cId) firstRects.set(cId, c.getBoundingClientRect());
      });

      // 2. Temporarily move ghost card in the DOM to target position
      // so other sibling cards naturally shift and we get the true destination rect
      const refNode = targetSlot < cards.length ? cards[targetSlot] : null;
      this.container.insertBefore(card, refNode);

      // 3. Snapshot destination position of the dropped card and new positions of other cards
      const destRect = card.getBoundingClientRect();
      const updatedCards = this.getCards();

      // 4. Invert all other cards (FLIP)
      updatedCards.forEach(c => {
        if (c === card) return;
        const cId = c.getAttribute(this.options.idAttribute);
        const firstRect = firstRects.get(cId);
        if (firstRect) {
          const lastRect = c.getBoundingClientRect();
          const deltaY = firstRect.top - lastRect.top;
          if (Math.abs(deltaY) > 1) {
            c.style.transition = 'none';
            c.style.transform = `translateY(${deltaY}px)`;
          }
        }
      });

      // 5. Calculate delta for floating card to glide directly into destRect
      const deltaX = destRect.left - floatingRect.left;
      const deltaY = destRect.top - floatingRect.top;

      // Force layout flush so inversion is committed
      void floatingEl.offsetHeight;
      void this.container.offsetHeight;

      // 6. Animate floating card into destRect
      floatingEl.style.transition = `transform ${durationMs}ms ${easing}, box-shadow ${durationMs}ms ease, border-color ${durationMs}ms ease`;
      floatingEl.style.transform = `translate(${deltaX}px, ${deltaY}px) scale(1) rotate(0deg)`;
      floatingEl.style.boxShadow = 'var(--shadow-card)';
      floatingEl.style.borderColor = 'var(--border-subtle)';

      // 7. Animate other cards to their new resting positions
      updatedCards.forEach(c => {
        if (c !== card && c.style.transform) {
          c.style.transition = `transform ${durationMs}ms ${easing}`;
          c.style.transform = '';
        }
      });

      // 8. On transition completion, commit state and re-render cleanly
      setTimeout(() => {
        if (floatingEl.parentNode) floatingEl.remove();
        card.classList.remove(ghost);

        updatedCards.forEach(c => {
          c.style.transition = '';
          c.style.transform = '';
        });

        const targetCard = cards[newIdx];
        const targetId = targetCard ? targetCard.getAttribute(this.options.idAttribute) : null;
        const placeBefore = newIdx < origIdx;

        if (typeof this.options.onReorder === 'function') {
          this.options.onReorder(origIdx, newIdx, id, targetId, placeBefore);
        }

        if (typeof this.options.onRender === 'function') {
          this.options.onRender();
        }

        const selector = `[${this.options.idAttribute}="${CSS && CSS.escape ? CSS.escape(id) : id}"]`;
        const landedEl = this.container.querySelector(selector);
        if (landedEl) {
          landedEl.classList.add(landed);
          setTimeout(() => landedEl.classList.remove(landed), 600);
        }

        this.container.style.pointerEvents = '';
        this.isExchanging = false;
      }, durationMs);
    }
  }

  return CardPhysics;
}));

