import { Router } from 'express';
import * as UsersController from '../controllers/users.controller';
import { requireAdmin } from '../middleware/auth';

const router = Router();

router.get('/', requireAdmin, UsersController.getUsers);
router.get('/:id', requireAdmin, UsersController.getUserById);
router.post('/', requireAdmin, UsersController.createUser);
router.put('/:id', requireAdmin, UsersController.updateUser);
router.post('/:id/favorites/add', requireAdmin, UsersController.addFavoriteShop);
router.post('/:id/favorites/remove', requireAdmin, UsersController.removeFavoriteShop);
router.post('/:id/agenda/add', requireAdmin, UsersController.addToAgenda);
router.post('/:id/agenda/remove', requireAdmin, UsersController.removeFromAgenda);

export default router;
