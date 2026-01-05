import 'dotenv/config';
import app from './app'; // <- QUITA EL .js AQUÍ

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
