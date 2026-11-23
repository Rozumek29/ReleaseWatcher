/** The message of a thrown value (an `Error`'s message, anything else converted to a string). */
export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
