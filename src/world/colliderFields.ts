/**
 * Packed Float64Array layout for colliderWorker → BuildingColliderIndex.
 *
 * i,p,x,y,z,hx,hy,hz,yaw,cosYaw,sinYaw,s,vol,qx,qy,qz,qw
 * qw === 0 means "no quat" (use yaw); a real orientation has qw !== 0.
 */
export const COLLIDER_FIELDS = 17;
