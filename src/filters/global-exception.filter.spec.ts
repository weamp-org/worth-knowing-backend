import {
  BadRequestException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';

import { GlobalExceptionFilter } from './global-exception.filter';

describe('GlobalExceptionFilter', () => {
  let filter: GlobalExceptionFilter;
  let statusFn: jest.Mock;
  let jsonFn: jest.Mock;

  const mockHost = (url = '/api/v1/resources') =>
    ({
      switchToHttp: () => ({
        getResponse: () => ({ status: statusFn }),
        getRequest: () => ({ method: 'GET', url }),
      }),
    }) as never;

  beforeEach(() => {
    filter = new GlobalExceptionFilter();
    jsonFn = jest.fn();
    statusFn = jest.fn().mockReturnValue({ json: jsonFn });
    jest.spyOn(filter['logger'], 'error').mockImplementation(() => {});
    jest.spyOn(filter['logger'], 'warn').mockImplementation(() => {});
  });

  it('returns a generic message for unexpected errors', () => {
    filter.catch(new Error('connect ECONNREFUSED 10.0.0.1:5432'), mockHost());

    expect(statusFn).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    const [[body]] = jsonFn.mock.calls as unknown as [[{ message: string }]];
    expect(body.message).toBe('Internal server error');
  });

  it('returns a generic message for non-Error throws', () => {
    filter.catch('some string throw', mockHost());

    expect(statusFn).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Internal server error' }),
    );
  });

  it('preserves known HTTP exception messages', () => {
    filter.catch(new NotFoundException('Resource res_1 not found'), mockHost());

    expect(statusFn).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.NOT_FOUND,
        message: 'Resource res_1 not found',
      }),
    );
  });

  it('joins ValidationPipe array messages', () => {
    filter.catch(
      new BadRequestException(['title is required', 'url is required']),
      mockHost(),
    );

    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'title is required, url is required',
      }),
    );
  });
});
