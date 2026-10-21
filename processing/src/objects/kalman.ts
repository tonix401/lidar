// Constant-velocity Kalman filter on (x, y); both axes share one covariance (same model, same noise).

export const KF_Q = 9;                // acceleration variance (σ 3 m/s²)
export const KF_R = 0.08 ** 2;        // centroid measurement variance (σ 8 cm)

export interface KalmanState { x: number; y: number; vx: number; vy: number; P: [number, number, number] }   // P = [p00, p01, p11]

export const kfInit = (x: number, y: number): KalmanState => ({ x, y, vx: 0, vy: 0, P: [KF_R, 0, 4] });

export function kfPredict(t: KalmanState, dt: number): void {
  const [p00, p01, p11] = t.P;
  t.x += t.vx * dt; t.y += t.vy * dt;
  t.P = [p00 + 2 * dt * p01 + dt * dt * p11 + KF_Q * dt ** 4 / 4, p01 + dt * p11 + KF_Q * dt ** 3 / 2, p11 + KF_Q * dt * dt];
}

export function kfUpdate(t: KalmanState, mx: number, my: number): void {
  const [p00, p01, p11] = t.P, S = p00 + KF_R, k0 = p00 / S, k1 = p01 / S, ix = mx - t.x, iy = my - t.y;
  t.x += k0 * ix; t.y += k0 * iy; t.vx += k1 * ix; t.vy += k1 * iy;
  t.P = [(1 - k0) * p00, (1 - k0) * p01, p11 - k1 * p01];
}
