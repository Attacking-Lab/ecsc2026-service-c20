#define PY_SSIZE_T_CLEAN
#include <Python.h>

#include "zkp_core.h"

#include <stdlib.h>

static PyObject *python_prove(PyObject *Py_UNUSED(self), PyObject *args) {
    const uint8_t *public_key;
    const uint8_t *secret_key;
    Py_ssize_t public_key_length;
    Py_ssize_t secret_key_length;
    if (!PyArg_ParseTuple(args, "y#y#:prove", &public_key, &public_key_length, &secret_key, &secret_key_length)) {
        return NULL;
    }

    uint8_t *proof = malloc(ZKP_PROOF_CAPACITY);
    if (proof == NULL) return PyErr_NoMemory();
    size_t proof_length;

    /*
     * args owns the immutable y# buffers for this whole wrapper call.
     * zkp_prove only accesses native memory and does not call the Python API,
     * so it is safe to let other Python threads run while it computes.
     */
    Py_BEGIN_ALLOW_THREADS
    proof_length =
        zkp_prove(public_key, (size_t)public_key_length, secret_key, (size_t)secret_key_length, proof);
    Py_END_ALLOW_THREADS

    PyObject *result = PyBytes_FromStringAndSize((const char *)proof, (Py_ssize_t)proof_length);
    free(proof);
    return result;
}

static PyObject *python_verify(PyObject *Py_UNUSED(self), PyObject *args) {
    const uint8_t *public_key;
    const uint8_t *proof;
    Py_ssize_t public_key_length;
    Py_ssize_t proof_length;
    if (!PyArg_ParseTuple(args, "y#y#:verify", &public_key, &public_key_length, &proof, &proof_length)) {
        return NULL;
    }
    bool valid;

    /* args likewise keeps both borrowed input buffers alive here. */
    Py_BEGIN_ALLOW_THREADS
    valid = zkp_verify(public_key, (size_t)public_key_length, proof, (size_t)proof_length);
    Py_END_ALLOW_THREADS

    return PyBool_FromLong(valid);
}

static PyMethodDef methods[] = {
    {"prove", python_prove, METH_VARARGS, PyDoc_STR("prove(public_key, secret_key) -> proof bytes")},
    {"verify", python_verify, METH_VARARGS, PyDoc_STR("verify(public_key, proof) -> bool")},
    {NULL, NULL, 0, NULL},
};

static struct PyModuleDef module = {
    .m_base = PyModuleDef_HEAD_INIT,
    .m_name = "zkp_lib",
    .m_doc = "Fixed-parameter LWE zero-knowledge proof bindings.",
    .m_size = -1,
    .m_methods = methods,
};

PyMODINIT_FUNC PyInit_zkp_lib(void) {
    return PyModule_Create(&module);
}
