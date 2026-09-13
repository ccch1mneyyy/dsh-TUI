/**
 * Shared plain data types used by the Kernel and upstream driver contract.
 *
 * These are deliberately not Standard/Spec protocol definitions: they are the
 * minimal coordinate/key shapes that drivers, kernel and descriptor plumbing
 * need to agree on without upstream importing the Standard plane.
 */

export interface ContractCoordinate {
  readonly apiVersion: string
  readonly kind: string
}

export interface ContractRef extends ContractCoordinate {
  readonly optional?: boolean
  readonly fallback?: string
}
