/**
 * The caller's own preferences.
 *
 * The template's `UserResponseDto` — id, name, email, imageUrl, role — is gone
 * along with the routes that returned it. A settings endpoint has no business
 * handing back an email address or a role that nobody asked for, and
 * `DELETE /users/:id` describes its own return inline rather than with a DTO
 * whose fields are all identity.
 */
export class MySettingsDto {
  /** Whether contributions are shared anonymously unless overridden.
   * @example true
   */
  anonymousByDefault: boolean;
}
