/**
 * Extract display name from profile metadata
 * Single purpose: UserProfile → display name string
 * Priority: display_name > name > username > empty string
 *
 * @param profile - User profile object with optional name fields
 * @returns Display name string (empty if none found)
 *
 * @example
 * extractDisplayName({ display_name: 'John Doe', name: 'john' })
 * // => 'John Doe'
 *
 * extractDisplayName({ name: 'alice' })
 * // => 'alice'
 *
 * extractDisplayName({})
 * // => ''
 */

export interface ProfileWithNames {
  display_name?: string;
  name?: string;
  username?: string;
}

export function extractDisplayName(profile: ProfileWithNames): string {
  if (profile.display_name?.trim()) {
    return profile.display_name.trim();
  }
  if (profile.name?.trim()) {
    return profile.name.trim();
  }
  if (profile.username?.trim()) {
    return profile.username.trim();
  }
  return '';
}
