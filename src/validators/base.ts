/**
 * Validator base class.
 *
 * Defines the interface every validator must implement, keeping validators
 * consistent and extensible.
 *
 * Design principles:
 * - Single responsibility: each validator checks one data structure.
 * - Unified interface: every validator implements the same interface.
 * - Detailed errors: validation failures should provide clear error messages.
 */

/**
 * Validator base class (abstract class).
 *
 * All custom validators must extend this class and implement the validate
 * method and name property.
 *
 * Example:
 *   class MyValidator extends BaseValidator {
 *     get name() { return "my_validator"; }
 *     validate(data: unknown): boolean {
 *       if (typeof data !== "object" || data === null || Array.isArray(data)) {
 *         throw new Error("Data must be an object");
 *       }
 *       return true;
 *     }
 *   }
 *
 *   const validator = new MyValidator();
 *   validator.validate({ key: "value" }); // true
 */
export abstract class BaseValidator {
  readonly config: Record<string, unknown>;

  /**
   * Initializes the validator.
   *
   * @param config Validator config object from YAML `validator_config`.
   *               It may contain any parameters that the concrete validator
   *               interprets and uses.
   *
   * Config example:
   *   validator_config:
   *     strict_mode: true       # Strict mode
   *     max_paragraphs: 100     # Maximum paragraph count
   *     allow_empty: false      # Whether to allow an empty object
   */
  constructor(config: Record<string, unknown> = {}) {
    this.config = config;
  }

  /**
   * Validator name (abstract property, required in subclasses).
   *
   * Returns the validator's unique identifier for YAML config references.
   * Naming convention: lowercase letters, underscores between words, concise
   * and clear.
   *
   * Naming examples:
   *   - "pdf_page"    # PDF page
   *   - "simple_json" # Simple JSON
   *   - "chapter"     # Chapter
   *   - "table_data"  # Table data
   */
  abstract get name(): string;

  /**
   * Validates data (abstract method, required in subclasses).
   *
   * @param data Data to validate, usually a parsed JSON object.
   * @returns Must return true when validation passes.
   * @throws Error Must be thrown when validation fails, with a detailed
   *               description.
   *
   * Implementation requirements:
   *   1. Throw Error when validation fails; do not return false.
   *   2. Make error messages detailed. Suggested format: mark the error,
   *      expected value, actual value, and fix suggestion.
   *   3. Return true when validation passes.
   */
  abstract validate(data: unknown): boolean;

  toString(): string {
    return `<${this.constructor.name}(name='${this.name}')>`;
  }
}
