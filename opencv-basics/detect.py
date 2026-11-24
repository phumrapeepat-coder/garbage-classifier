import cv2
import numpy as np

def to_gray(img):
    # TODO A: convert BGR -> grayscale yourself
    #   gray = 0.299*R + 0.587*G + 0.114*B
    #   careful: OpenCV channel order is B, G, R  (img[:,:,0] is BLUE)
    #   return as uint8
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    return gray

def mean_blur(gray, k=5):
    # TODO B: k x k mean filter (like your LAB04 median filter, but np.mean)
    #   pad with np.pad(gray, k//2, mode='edge'), loop over pixels
    h,w = gray.shape
    padded = np.pad(gray, k//2, mode = 'edge')
    result = np.zeros_like(gray)
    for i in range(h):
        for j in range(w):
            result[i,j] = np.average(padded[i:i+k, j:j+k])
    return result

def auto_threshold(gray, eps=1, max_iter = 100):
    # TODO C: iterative threshold from LAB05 Ex 1.2
    #   start T = gray.mean()
    #   loop: m1 = mean of pixels > T, m2 = mean of pixels <= T
    #         new_T = (m1 + m2) / 2 ; stop when |new_T - T| < eps
    #   return T
    gray = gray.astype(np.float64)
    T = gray.mean()
    new_T = T
    for _ in range(max_iter):
        g1 = gray[gray>T]
        g2 = gray[gray<=T]

        if g1.size == 0 or g2.size == 0:
            break

        m1 = g1.mean()             
        m2 = g2.mean()

        new_T = (m1+m2)/2

        if (np.abs(new_T-T)<eps):
            break
        T = new_T
    return T

def make_mask(gray, T):
    # TODO D: objects are DARKER than white paper
    #   mask = 255 where gray < T, else 0  (uint8)
    mask = np.zeros_like(gray)
    mask[gray < T] = 255          
    return mask

if __name__ == "__main__":
    img = cv2.imread("capture.jpg")
    gray = to_gray(img)
    blurred = mean_blur(gray)
    T = auto_threshold(blurred)
    print("Threshold:", T)
    mask = make_mask(blurred, T)

    cv2.imshow("Original", img)
    cv2.imshow("Gray", gray)
    cv2.imshow("Blurred", blurred)
    cv2.imshow("Mask", mask)
    cv2.waitKey(0)            # wait for any key
    cv2.destroyAllWindows()