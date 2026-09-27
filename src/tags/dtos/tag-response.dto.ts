/** One row from the tag typeahead. */
export class TagSearchResultDto {
  id: string;

  /** Display form as the contributor typed it
   * @example 'Machine Learning'
   */
  name: string;

  /** Normalized identity, safe to put in a URL once percent-encoded
   * @example 'machine-learning'
   */
  slug: string;

  /** How many resources carry this tag. */
  resourceCount: number;
}
