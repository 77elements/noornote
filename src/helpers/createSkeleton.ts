/**
 * Unified Skeleton Loader Factory
 * Creates skeleton loaders for different content types
 *
 * @module createSkeleton
 * @purpose Centralized skeleton creation with backwards compatibility
 */

/**
 * Skeleton templates for different content types
 */
const SKELETON_TEMPLATES = {
  note: `
    <div class="skeleton-header">
      <div class="skeleton-avatar"></div>
      <div class="skeleton-text-group">
        <div class="skeleton-line skeleton-name"></div>
        <div class="skeleton-line skeleton-timestamp"></div>
      </div>
    </div>
    <div class="skeleton-content">
      <div class="skeleton-line skeleton-text-line"></div>
      <div class="skeleton-line skeleton-text-line"></div>
      <div class="skeleton-line skeleton-text-line short"></div>
    </div>
  `,
  media: {
    image: '',
    video: '<div class="media-skeleton__play-icon">▶</div>',
  },
  profile: '',
};

/**
 * Generic skeleton factory
 * Creates skeleton loader elements based on type and variant
 *
 * @param type - Skeleton type: 'note' | 'media' | 'profile'
 * @param variant - Type-specific variant (e.g., 'image'/'video' for media, 'small'/'medium'/'large' for profile)
 * @returns HTMLElement skeleton loader
 */
export function createSkeleton(
  type: 'note' | 'media' | 'profile',
  variant?: string
): HTMLElement {
  const skeleton = document.createElement('div');

  switch (type) {
    case 'note':
      skeleton.className = 'note-skeleton';
      skeleton.innerHTML = SKELETON_TEMPLATES.note;
      break;

    case 'media': {
      const mediaType = (variant as 'image' | 'video') || 'image';
      skeleton.className = `media-skeleton media-skeleton--${mediaType}`;
      skeleton.innerHTML = SKELETON_TEMPLATES.media[mediaType];
      break;
    }

    case 'profile': {
      const size = variant || 'medium';
      skeleton.className = `profile-skeleton profile-skeleton--${size}`;
      skeleton.innerHTML = SKELETON_TEMPLATES.profile;
      break;
    }

    default:
      throw new Error(`Unknown skeleton type: ${type}`);
  }

  return skeleton;
}

/**
 * Backwards compatibility: Create skeleton loader for note
 *
 * @returns HTMLElement skeleton
 *
 * @example
 * const skeleton = createNoteSkeleton();
 * container.appendChild(skeleton);
 */
export function createNoteSkeleton(): HTMLElement {
  return createSkeleton('note');
}

/**
 * Backwards compatibility: Create skeleton loader for media content
 *
 * @param type - Media type: 'image' | 'video'
 * @returns HTMLElement skeleton
 *
 * @example
 * const skeleton = createMediaSkeleton('image');
 * mediaContainer.appendChild(skeleton);
 */
export function createMediaSkeleton(
  type: 'image' | 'video' = 'image'
): HTMLElement {
  return createSkeleton('media', type);
}

/**
 * Backwards compatibility: Create skeleton loader for profile picture
 *
 * @param size - Size variant: 'small' | 'medium' | 'large'
 * @returns HTMLElement skeleton
 *
 * @example
 * const skeleton = createProfileSkeleton('medium');
 * avatarContainer.appendChild(skeleton);
 */
export function createProfileSkeleton(
  size: 'small' | 'medium' | 'large' = 'medium'
): HTMLElement {
  return createSkeleton('profile', size);
}
