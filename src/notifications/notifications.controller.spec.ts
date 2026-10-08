import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';

import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { RolesGuard } from '../roles/roles.guard';
import { ClerkAuthGuard } from '../clerk-auth/clerk-auth.guard';
import { PrismaService } from '../prisma/prisma.service';

const mockNotificationsService = {
  findMine: jest.fn(),
  unreadCount: jest.fn(),
  markRead: jest.fn(),
  markAllRead: jest.fn(),
};

describe('NotificationsController', () => {
  let controller: NotificationsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [NotificationsController],
      providers: [
        { provide: NotificationsService, useValue: mockNotificationsService },
        RolesGuard,
        ClerkAuthGuard,
        { provide: Reflector, useValue: { getAllAndOverride: jest.fn() } },
        {
          provide: PrismaService,
          useValue: { user: { findUnique: jest.fn() } },
        },
      ],
    }).compile();

    controller = module.get(NotificationsController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('findMine', () => {
    it('takes the caller from the session and forwards the pagination', async () => {
      await controller.findMine('clerk_123', { limit: 5, cursor: 'abc' });

      expect(mockNotificationsService.findMine).toHaveBeenCalledWith(
        'clerk_123',
        5,
        'abc',
      );
    });
  });

  describe('unreadCount', () => {
    it('wraps the answer as a count flag', async () => {
      mockNotificationsService.unreadCount.mockResolvedValue(2);

      const result = await controller.unreadCount('clerk_123');

      expect(result).toEqual({ count: 2 });
    });
  });

  describe('markRead', () => {
    it('forwards the id and the caller', async () => {
      await controller.markRead('notif_1', 'clerk_123');

      expect(mockNotificationsService.markRead).toHaveBeenCalledWith(
        'clerk_123',
        'notif_1',
      );
    });
  });

  describe('markAllRead', () => {
    it('forwards the caller', async () => {
      await controller.markAllRead('clerk_123');

      expect(mockNotificationsService.markAllRead).toHaveBeenCalledWith(
        'clerk_123',
      );
    });
  });
});
