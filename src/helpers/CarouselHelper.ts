/**
 * CarouselHelper - Reusable carousel components
 *
 * Two variants:
 *
 * 1. Step Carousel (createCarousel / setupCarouselNavigation)
 *    One slide at a time, dots + prev/next buttons. Used in onboarding.
 *
 * 2. Scroll Carousel (createScrollCarousel)
 *    Multiple items visible, horizontal scroll with arrow buttons. Used in profile view.
 *
 * Step Carousel Usage:
 * const carousel = createCarousel(slides);
 * container.appendChild(carousel.element);
 * carousel.init();
 *
 * Scroll Carousel Usage:
 * const carousel = createScrollCarousel({ title: 'Videos', cards: [...] });
 * container.appendChild(carousel.element);
 */

export interface CarouselSlide {
  /** Plain text only — rendered via textContent. Never pass HTML from untrusted sources. */
  text: string;
  image?: string;
  imageAlt?: string;
}

export interface CarouselOptions {
  showNav?: boolean;
  showDots?: boolean;
  prevLabel?: string;
  nextLabel?: string;
  onSlideChange?: (index: number) => void;
}

export interface CarouselInstance {
  element: HTMLElement;
  init: () => void;
  goTo: (index: number) => void;
  next: () => void;
  prev: () => void;
  getCurrentIndex: () => number;
  destroy: () => void;
}

/** Add touch swipe support to a carousel container */
function addSwipeSupport(
  container: HTMLElement,
  onSwipeLeft: () => void,
  onSwipeRight: () => void
): void {
  let startX = 0;
  let startY = 0;

  container.addEventListener('touchstart', (e: TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    startX = touch.clientX;
    startY = touch.clientY;
  }, { passive: true });

  container.addEventListener('touchend', (e: TouchEvent) => {
    const touch = e.changedTouches[0];
    if (!touch) return;
    const deltaX = touch.clientX - startX;
    const deltaY = touch.clientY - startY;

    // Only trigger if horizontal swipe is dominant and exceeds threshold
    if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 50) {
      if (deltaX < 0) onSwipeLeft();
      else onSwipeRight();
    }
  }, { passive: true });
}

const defaultOptions: CarouselOptions = {
  showNav: true,
  showDots: true,
  prevLabel: 'Previous',
  nextLabel: 'Next',
};

/**
 * Create a carousel element from slides
 */
export function createCarousel(
  slides: CarouselSlide[],
  options: CarouselOptions = {}
): CarouselInstance {
  const opts = { ...defaultOptions, ...options };

  // Build HTML
  const carousel = document.createElement('div');
  carousel.className = 'nn-carousel';

  // Slides container
  const slidesContainer = document.createElement('div');
  slidesContainer.className = 'nn-carousel-slides';

  slides.forEach((slide, index) => {
    const slideEl = document.createElement('div');
    slideEl.className = `nn-carousel-slide${index === 0 ? ' active' : ''}`;
    slideEl.dataset.slide = String(index);

    if (slide.image) {
      const img = document.createElement('img');
      img.src = slide.image;
      img.alt = slide.imageAlt || '';
      img.className = 'nn-carousel-image';
      slideEl.appendChild(img);
    }

    const contentDiv = document.createElement('div');
    contentDiv.textContent = slide.text;
    slideEl.appendChild(contentDiv);

    slidesContainer.appendChild(slideEl);
  });

  carousel.appendChild(slidesContainer);

  // Navigation
  let prevBtn: HTMLButtonElement | null = null;
  let nextBtn: HTMLButtonElement | null = null;
  let dotsContainer: HTMLElement | null = null;

  if (opts.showNav || opts.showDots) {
    const nav = document.createElement('div');
    nav.className = 'nn-carousel-nav';

    if (opts.showNav) {
      prevBtn = document.createElement('button');
      prevBtn.className = 'btn btn--mini btn--passive';
      prevBtn.setAttribute('data-action', 'prev-slide');
      prevBtn.disabled = true;
      prevBtn.textContent = opts.prevLabel || 'Previous';
      nav.appendChild(prevBtn);
    }

    if (opts.showDots) {
      dotsContainer = document.createElement('span');
      dotsContainer.className = 'nn-carousel-dots';
      nav.appendChild(dotsContainer);
    }

    if (opts.showNav) {
      nextBtn = document.createElement('button');
      nextBtn.className = 'btn btn--mini';
      nextBtn.setAttribute('data-action', 'next-slide');
      nextBtn.textContent = opts.nextLabel || 'Next';
      nav.appendChild(nextBtn);
    }

    carousel.appendChild(nav);
  }

  // State
  let currentIndex = 0;
  const totalSlides = slides.length;
  let dots: HTMLElement[] = [];

  const updateSlide = (newIndex: number) => {
    const slideEls = slidesContainer.querySelectorAll('.nn-carousel-slide');

    slideEls[currentIndex]?.classList.remove('active');
    dots[currentIndex]?.classList.remove('active');

    currentIndex = newIndex;

    slideEls[currentIndex]?.classList.add('active');
    dots[currentIndex]?.classList.add('active');

    if (prevBtn) prevBtn.disabled = currentIndex === 0;
    if (nextBtn) nextBtn.disabled = currentIndex === totalSlides - 1;

    opts.onSlideChange?.(currentIndex);
  };

  const init = () => {
    // Create dots
    if (dotsContainer) {
      for (let i = 0; i < totalSlides; i++) {
        const dot = document.createElement('span');
        dot.className = `nn-carousel-dot${i === 0 ? ' active' : ''}`;
        dot.dataset.slide = String(i);
        dot.addEventListener('click', () => updateSlide(i));
        dotsContainer.appendChild(dot);
        dots.push(dot);
      }
    }

    // Button listeners
    prevBtn?.addEventListener('click', () => {
      if (currentIndex > 0) updateSlide(currentIndex - 1);
    });

    nextBtn?.addEventListener('click', () => {
      if (currentIndex < totalSlides - 1) updateSlide(currentIndex + 1);
    });

    // Touch swipe
    addSwipeSupport(
      slidesContainer,
      () => { if (currentIndex < totalSlides - 1) updateSlide(currentIndex + 1); },
      () => { if (currentIndex > 0) updateSlide(currentIndex - 1); }
    );
  };

  const destroy = () => {
    carousel.remove();
  };

  return {
    element: carousel,
    init,
    goTo: updateSlide,
    next: () => {
      if (currentIndex < totalSlides - 1) updateSlide(currentIndex + 1);
    },
    prev: () => {
      if (currentIndex > 0) updateSlide(currentIndex - 1);
    },
    getCurrentIndex: () => currentIndex,
    destroy,
  };
}

/**
 * Setup carousel navigation for an existing carousel element
 * Use this when the HTML is already in the DOM
 */
export function setupCarouselNavigation(
  container: HTMLElement,
  onSlideChange?: (index: number) => void
): { goTo: (index: number) => void; getCurrentIndex: () => number } {
  const slides = container.querySelectorAll('.nn-carousel-slide');
  const prevBtn = container.querySelector('[data-action="prev-slide"]') as HTMLButtonElement | null;
  const nextBtn = container.querySelector('[data-action="next-slide"]') as HTMLButtonElement | null;
  const dotsContainer = container.querySelector('.nn-carousel-dots');

  let currentIndex = 0;
  const totalSlides = slides.length;

  // Create dots if container exists but is empty
  if (dotsContainer && dotsContainer.children.length === 0) {
    for (let i = 0; i < totalSlides; i++) {
      const dot = document.createElement('span');
      dot.className = `nn-carousel-dot${i === 0 ? ' active' : ''}`;
      dot.dataset.slide = String(i);
      dotsContainer.appendChild(dot);
    }
  }

  const dots = dotsContainer?.querySelectorAll('.nn-carousel-dot') || [];

  const updateSlide = (newIndex: number) => {
    slides[currentIndex]?.classList.remove('active');
    dots[currentIndex]?.classList.remove('active');

    currentIndex = newIndex;

    slides[currentIndex]?.classList.add('active');
    dots[currentIndex]?.classList.add('active');

    if (prevBtn) prevBtn.disabled = currentIndex === 0;
    if (nextBtn) nextBtn.disabled = currentIndex === totalSlides - 1;

    onSlideChange?.(currentIndex);
  };

  // Button listeners
  prevBtn?.addEventListener('click', () => {
    if (currentIndex > 0) updateSlide(currentIndex - 1);
  });

  nextBtn?.addEventListener('click', () => {
    if (currentIndex < totalSlides - 1) updateSlide(currentIndex + 1);
  });

  // Touch swipe
  const slidesEl = container.querySelector('.nn-carousel-slides') as HTMLElement || container;
  addSwipeSupport(
    slidesEl,
    () => { if (currentIndex < totalSlides - 1) updateSlide(currentIndex + 1); },
    () => { if (currentIndex > 0) updateSlide(currentIndex - 1); }
  );

  // Dot listeners
  dots.forEach((dot) => {
    dot.addEventListener('click', () => {
      const index = parseInt((dot as HTMLElement).dataset.slide || '0', 10);
      updateSlide(index);
    });
  });

  return {
    goTo: updateSlide,
    getCurrentIndex: () => currentIndex,
  };
}

// ========================================
// Scroll Carousel (horizontal, multiple items visible)
// ========================================

export interface ScrollCarouselCard {
  html: string;
  data?: Record<string, string>;
}

export interface ScrollCarouselOptions {
  title: string;
  cards: ScrollCarouselCard[];
  /** Minimum cards before showing nav arrows (default: 2) */
  navThreshold?: number;
  onCardClick?: (index: number, data: Record<string, string>) => void;
}

export interface ScrollCarouselInstance {
  element: HTMLElement;
  destroy: () => void;
}

/**
 * Create a horizontal scroll carousel with cards
 * Used for profile articles, videos, etc.
 */
export function createScrollCarousel(options: ScrollCarouselOptions): ScrollCarouselInstance {
  const { title, cards, navThreshold = 2, onCardClick } = options;
  const showNav = cards.length > navThreshold;

  const wrapper = document.createElement('div');
  wrapper.className = 'nn-scroll-carousel';

  wrapper.innerHTML = `
    <div class="nn-scroll-carousel__header">
      <h2 class="nn-scroll-carousel__title">${title}</h2>
      ${showNav ? `
        <div class="nn-scroll-carousel__nav">
          <button class="btn btn--square-sm nn-scroll-carousel__nav-btn nn-scroll-carousel__nav-btn--prev" aria-label="Previous">
            <span class="carousel-chevron-left" aria-hidden="true"></span>
          </button>
          <button class="btn btn--square-sm nn-scroll-carousel__nav-btn nn-scroll-carousel__nav-btn--next" aria-label="Next">
            <span class="carousel-chevron-right" aria-hidden="true"></span>
          </button>
        </div>
      ` : ''}
    </div>
    <div class="nn-scroll-carousel__viewport">
      <div class="nn-scroll-carousel__track">
        ${cards.map((card, i) => {
          const dataAttrs = card.data
            ? Object.entries(card.data).map(([k, v]) => `data-${k}="${v}"`).join(' ')
            : '';
          return `<div class="nn-card" data-index="${i}" ${dataAttrs}>${card.html}</div>`;
        }).join('')}
      </div>
    </div>
  `;

  // Nav button state
  const updateNavButtons = () => {
    const viewport = wrapper.querySelector('.nn-scroll-carousel__viewport') as HTMLElement;
    const prevBtn = wrapper.querySelector('.nn-scroll-carousel__nav-btn--prev') as HTMLElement;
    const nextBtn = wrapper.querySelector('.nn-scroll-carousel__nav-btn--next') as HTMLElement;
    if (!viewport || !prevBtn || !nextBtn) return;

    prevBtn.classList.toggle('nn-scroll-carousel__nav-btn--disabled', viewport.scrollLeft <= 0);
    const remaining = viewport.scrollWidth - (viewport.scrollLeft + viewport.clientWidth);
    nextBtn.classList.toggle('nn-scroll-carousel__nav-btn--disabled', remaining < 50);
  };

  // Scroll by one card width
  const scroll = (direction: number) => {
    const viewport = wrapper.querySelector('.nn-scroll-carousel__viewport') as HTMLElement;
    const card = wrapper.querySelector('[data-index]') as HTMLElement;
    if (!viewport || !card) return;
    viewport.scrollBy({ left: (card.offsetWidth + 16) * direction, behavior: 'smooth' });
  };

  // Event listeners
  const prevBtn = wrapper.querySelector('.nn-scroll-carousel__nav-btn--prev');
  const nextBtn = wrapper.querySelector('.nn-scroll-carousel__nav-btn--next');
  prevBtn?.addEventListener('click', (e) => { e.stopPropagation(); scroll(-1); });
  nextBtn?.addEventListener('click', (e) => { e.stopPropagation(); scroll(1); });

  const viewport = wrapper.querySelector('.nn-scroll-carousel__viewport');
  viewport?.addEventListener('scroll', updateNavButtons);

  // Card click
  if (onCardClick) {
    wrapper.querySelectorAll('[data-index]').forEach(card => {
      card.addEventListener('click', () => {
        const el = card as HTMLElement;
        const index = parseInt(el.dataset.index || '0');
        const data: Record<string, string> = {};
        for (const [key, value] of Object.entries(el.dataset)) {
          if (key !== 'index') data[key] = value!;
        }
        onCardClick(index, data);
      });
    });
  }

  // Initial nav state
  requestAnimationFrame(updateNavButtons);

  return {
    element: wrapper,
    destroy: () => wrapper.remove()
  };
}
