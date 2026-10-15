import { Navigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import styles from './ProtectedRoute.module.css';

/**
 * Wraps protected pages and redirects unauthenticated users to the login page,
 * starting a new sign-in on the dashboard.
 */
export default function ProtectedRoute({ children }) {
  const { isAuthenticated, loading } = useAuth();

  // useAuth() It gives ProtectedRoute access to
  // isAuthenticated;
  // loading;

  // Session restore: show a neutral full-page loader (no route flash).
  if (loading) {
    return (
      <div className={styles.protectedRoute__screen} role="status">
        <div className={styles.protectedRoute__spinner} aria-hidden />
        <span>Checking your session…</span>
      </div>
    );
  }

  // Redirect to /auth if not authenticated.
  if (!isAuthenticated) {
    return <Navigate to="/auth" replace />;
  }

  // Render children if authenticated means the user is logged in and has access to the protected route
  return children;
}
