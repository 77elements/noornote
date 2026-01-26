/**
 * CarouselHelper - Reusable carousel component
 *
 * Usage:
 * const slides = [
 *   { content: '<p>Slide 1</p>' },
 *   { content: '<h3>Title</h3><p>Slide 2</p>', image: '/path/to/img.jpg' }
 * ];
 * const carousel = createCarousel(slides);
 * container.appendChild(carousel.element);
 * carousel.init();
 */

export interface CarouselSlide {
  content: string;
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
    contentDiv.innerHTML = slide.content;
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
