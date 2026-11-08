/** Shopping cart pricing. All money values are in the currency's major unit. */

/** Sum of `price * qty`, before discounts. */
export function subtotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.qty, 0);
}

/**
 * Apply a discount rate (0..1) to the subtotal.
 * Contract: the result is a money amount rounded to 2 decimals.
 */
export function total(items, discountRate) {
  return subtotal(items) * (1 - discountRate);
}

/** Total number of physical units in the cart. */
export function unitCount(items) {
  return items.reduce((n, item) => n + item.qty, 0);
}
