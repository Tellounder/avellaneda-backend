import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import * as ChatController from '../domains/chat/controller';

const router = Router();

router.get('/client/conversations', requireAuth, ChatController.listClientConversations);
router.post('/client/conversations/:shopId/open', requireAuth, ChatController.openClientConversation);
router.get('/client/conversations/:conversationId/messages', requireAuth, ChatController.listClientMessages);
router.post('/client/conversations/:conversationId/messages', requireAuth, ChatController.sendClientMessage);
router.post('/client/conversations/:conversationId/read', requireAuth, ChatController.markClientConversationRead);

router.get('/shop/conversations', requireAuth, ChatController.listShopConversations);
router.get('/shop/conversations/:conversationId/messages', requireAuth, ChatController.listShopMessages);
router.post('/shop/conversations/:conversationId/messages', requireAuth, ChatController.sendShopMessage);
router.post('/shop/conversations/:conversationId/read', requireAuth, ChatController.markShopConversationRead);

export default router;
