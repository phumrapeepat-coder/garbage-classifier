import cv2
import numpy as np

# TODO 1: open the default camera
index = 0
cap = cv2.VideoCapture(index)

# TODO 2: if the camera didn't open, print an error and exit

if (not cap.isOpened()):
    print("Cannot open camera")
    exit()

captured = None

while True:
    # TODO 3: read a frame; break if it failed
    ret, frame = cap.read()
    if not ret:
        print("Failed to grab frame")
        break
    # TODO 4: resize the frame to 320x240
    frame = cv2.resize(frame, (320, 240))

    # TODO 5: show the live frame in a window called "Live"
    cv2.imshow("Live", frame)
    key = cv2.waitKey(1) & 0xFF

    if key == ord('c'):
        # TODO 7: save a COPY of the frame as captured,
        #         write it to "capture.jpg", show it in a window "Captured"
        captured_img = frame.copy()
        cv2.imwrite('capture.jpg', captured_img)
        cv2.imshow("Captured", captured_img)
        pass

    elif key == ord('q'):
        break

# TODO 8: release the camera and close all windows
cap.release()
cv2.destroyAllWindows()