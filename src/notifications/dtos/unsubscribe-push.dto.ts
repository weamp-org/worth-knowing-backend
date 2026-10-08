import { IsUrl } from 'class-validator';

export class UnsubscribePushDto {
  /**
   * The push service's URL for the browser to forget. Scoped to the caller on
   * the way out, so one account cannot unsubscribe another's browser.
   */
  @IsUrl({ require_tld: false })
  endpoint: string;
}
