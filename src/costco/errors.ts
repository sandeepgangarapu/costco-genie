export class AuthRequiredError extends Error {
  constructor() {
    super(
      'Costco authentication is required. Run `costco login` and try again.',
    );
    this.name = 'AuthRequiredError';
  }
}

export class CostcoApiError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CostcoApiError';
  }
}
