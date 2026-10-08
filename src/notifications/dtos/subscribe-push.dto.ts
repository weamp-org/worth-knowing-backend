import { Type } from 'class-transformer';
import { IsNotEmpty, IsString, IsUrl, ValidateNested } from 'class-validator';

/** The browser's encryption keys for the payload. Opaque key material. */
class PushKeysDto {
  /** @example 'BNcRdreALRFXTkOOg...' */
  @IsString()
  @IsNotEmpty()
  p256dh: string;

  /** @example 'tBHI...s' */
  @IsString()
  @IsNotEmpty()
  auth: string;
}

export class SubscribePushDto {
  /**
   * The push service's URL for this browser. Globally unique, so it is the
   * upsert key: re-subscribing refreshes rather than doubles.
   * @example 'https://fcm.googleapis.com/fcm/send/abc123'
   */
  @IsUrl({ require_tld: false })
  endpoint: string;

  @ValidateNested()
  @Type(() => PushKeysDto)
  keys: PushKeysDto;
}
