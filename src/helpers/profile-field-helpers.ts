/**
 * Profile Field Helpers
 * Shared field renderers used by AccountSetupWizard and ProfileEditModal.
 * Each helper returns a .form-group HTMLElement with label, input, and optional hint.
 */

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Create a .form-group element with label + input/textarea + optional hint
 */
function createFormGroup(config: {
  id: string;
  label: string;
  inputHtml: string;
  hint?: string;
}): HTMLElement {
  const group = document.createElement('div');
  group.className = 'form-group';
  group.innerHTML = `
    <label for="${config.id}">${config.label}</label>
    ${config.inputHtml}
    ${config.hint ? `<small class="form-hint">${config.hint}</small>` : ''}
  `;
  return group;
}

export function renderUsernameField(value: string): HTMLElement {
  return createFormGroup({
    id: 'name',
    label: 'Username',
    inputHtml: `<input type="text" id="name" name="name" class="input" value="${escapeHtml(value)}" placeholder="username" data-input="name" />`
  });
}

export function renderDisplayNameField(value: string): HTMLElement {
  return createFormGroup({
    id: 'display_name',
    label: 'Display Name',
    inputHtml: `<input type="text" id="display_name" name="display_name" class="input" value="${escapeHtml(value)}" placeholder="Your full name" data-input="display_name" />`
  });
}

export function renderBioField(value: string): HTMLElement {
  return createFormGroup({
    id: 'about',
    label: 'Bio',
    inputHtml: `<textarea id="about" name="about" class="textarea textarea--small" rows="3" placeholder="Tell us about yourself..." data-input="about">${escapeHtml(value)}</textarea>`
  });
}

export function renderWebsiteField(value: string): HTMLElement {
  return createFormGroup({
    id: 'website',
    label: 'Website',
    inputHtml: `<input type="text" id="website" name="website" class="input" value="${escapeHtml(value)}" placeholder="https://example.com" data-input="website" />`
  });
}

export function renderNip05Field(value: string): HTMLElement {
  return createFormGroup({
    id: 'nip05',
    label: 'NIP-05 Identifier',
    inputHtml: `<input type="text" id="nip05" name="nip05" class="input" value="${escapeHtml(value)}" placeholder="user@domain.com" data-input="nip05" />`,
    hint: 'Verification identifier(s), comma-separated (user@domain.com, user@other.com)'
  });
}

export function renderLightningField(value: string): HTMLElement {
  return createFormGroup({
    id: 'lud16',
    label: 'Lightning Address',
    inputHtml: `<input type="text" id="lud16" name="lud16" class="input" value="${escapeHtml(value)}" placeholder="user@getalby.com" data-input="lud16" />`,
    hint: 'Email format (user@domain.com) or LNURL'
  });
}
