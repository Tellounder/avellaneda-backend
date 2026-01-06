import 'dotenv/config';
import app from './app'; // <- QUITA EL .js AQUÍ
import { startSchedulers } from './scheduler';

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  startSchedulers();
});
